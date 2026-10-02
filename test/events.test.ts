import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventStream } from '../src/events.js';
import { FakeWebSocket } from './helpers/fakes.js';

const VAULT = '0x00000000000000000000000000000000000000aa';

function open(filter = {}) {
  const stream = new EventStream('ws://solver.test/ws', filter, { WebSocket: FakeWebSocket });
  return { stream, socket: () => FakeWebSocket.instances.at(-1)! };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('EventStream', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the subscription on open and resolves ready() on the ack', async () => {
    const { stream, socket } = open({ vaults: [VAULT], events: ['intent.*', 'batch.settled'] });
    await flush();
    const ready = stream.ready();
    socket().serverOpen();
    expect(socket().sent).toEqual([{ op: 'subscribe', vaults: [VAULT], events: ['intent.*', 'batch.settled'] }]);
    socket().serverSend({ event: 'subscribed', data: { vaults: [VAULT], events: ['intent.*'] } });
    await expect(ready).resolves.toBeUndefined();
    expect(stream.connected).toBe(true);
    stream.close();
  });

  it('dispatches to exact, prefix and wildcard listeners with the payload and envelope', async () => {
    const { stream, socket } = open();
    await flush();
    socket().serverOpen();
    const exact = vi.fn();
    const prefix = vi.fn();
    const all = vi.fn();
    const other = vi.fn();
    stream.on('intent.settled', exact).on('intent.*', prefix).on('*', all).on('batch.settled', other);

    const envelope = { event: 'intent.settled', data: { intentId: '0x1', amountOut: '5' }, vault: VAULT, timestamp: 1 };
    socket().serverSend(envelope);
    expect(exact).toHaveBeenCalledWith(envelope.data, envelope);
    expect(prefix).toHaveBeenCalledOnce();
    expect(all).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    stream.close();
  });

  it('convenience helpers map to solver event names', async () => {
    const { stream, socket } = open();
    await flush();
    socket().serverOpen();
    const calls: string[] = [];
    stream
      .onIntentSettled(() => calls.push('settled'))
      .onBatchSettled(() => calls.push('batch'))
      .onCircuitBreaker(() => calls.push('breaker'))
      .onPriceChange(() => calls.push('price'));
    for (const event of ['intent.settled', 'batch.settled', 'vault.circuitBreaker', 'pool.price']) {
      socket().serverSend({ event, data: {}, timestamp: 0 });
    }
    expect(calls).toEqual(['settled', 'batch', 'breaker', 'price']);
    stream.close();
  });

  it('off() removes listeners; hello/pong are ignored; throwing listeners are isolated', async () => {
    const { stream, socket } = open();
    await flush();
    socket().serverOpen();
    const cb = vi.fn();
    const after = vi.fn();
    stream.on('pool.price', () => {
      throw new Error('boom');
    });
    stream.on('pool.price', after);
    stream.on('*', cb);
    socket().serverSend({ event: 'hello', data: {} });
    socket().serverSend({ event: 'pong' });
    expect(cb).not.toHaveBeenCalled();
    socket().serverSend({ event: 'pool.price', data: {}, timestamp: 0 });
    expect(after).toHaveBeenCalledOnce();
    stream.off('*', cb);
    socket().serverSend({ event: 'pool.price', data: {}, timestamp: 0 });
    expect(cb).toHaveBeenCalledOnce();
    stream.close();
  });

  it('surfaces server errors and bad JSON on the error channel', async () => {
    const { stream, socket } = open();
    await flush();
    socket().serverOpen();
    const errors: unknown[] = [];
    stream.on('error', (e) => errors.push(e));
    socket().serverSend({ event: 'error', data: { message: 'vaults must be an array of addresses' } });
    socket().onmessage?.({ data: 'not json' });
    expect(errors.map((e) => (e as Error).message)).toEqual([
      'Solver stream error: vaults must be an array of addresses',
      'Received a non-JSON message from the solver',
    ]);
    stream.close();
  });

  it('reconnects with backoff and re-subscribes', async () => {
    vi.useFakeTimers();
    const { stream, socket } = open({ events: ['pool.price'] });
    await vi.advanceTimersByTimeAsync(0);
    const first = socket();
    first.serverOpen();
    first.serverClose();
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    socket().serverOpen();
    expect(socket().sent).toEqual([{ op: 'subscribe', events: ['pool.price'] }]);
    // Second drop without a successful open in between backs off further
    socket().serverClose();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(3);
    socket().serverClose();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(4);
    stream.close();
  });

  it('close() stops reconnecting', async () => {
    vi.useFakeTimers();
    const { stream, socket } = open();
    await vi.advanceTimersByTimeAsync(0);
    socket().serverOpen();
    stream.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('falls back to the ws package when there is no global WebSocket (Node 18–21)', async () => {
    const { WebSocketServer } = await import('ws');
    const server = new WebSocketServer({ port: 0 });
    const port = (server.address() as { port: number }).port;
    server.on('connection', (ws) => {
      ws.on('message', () => {
        ws.send(JSON.stringify({ event: 'subscribed', data: {} }));
        ws.send(JSON.stringify({ event: 'pool.price', data: { pair: 'USDC/DAI' }, timestamp: 0 }));
      });
    });
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
    try {
      const stream = new EventStream(`ws://127.0.0.1:${port}/ws`, {});
      const price = new Promise((resolve) => stream.onPriceChange(resolve));
      await stream.ready();
      await expect(price).resolves.toEqual({ pair: 'USDC/DAI' });
      stream.close();
    } finally {
      if (saved) Object.defineProperty(globalThis, 'WebSocket', saved);
      server.close();
    }
  });

  it('setFilter re-sends the subscription', async () => {
    const { stream, socket } = open();
    await flush();
    socket().serverOpen();
    stream.setFilter({ vaults: [VAULT] });
    expect(socket().sent.at(-1)).toEqual({ op: 'subscribe', vaults: [VAULT] });
    stream.close();
  });
});
