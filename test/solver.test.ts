import { describe, expect, it } from 'vitest';
import { SolverError } from '../src/errors.js';
import { SolverClient } from '../src/solver.js';
import { fakeFetch } from './helpers/fakes.js';

describe('SolverClient', () => {
  it('builds GET /quote with query params and strips trailing slashes', async () => {
    const { fetch, requests } = fakeFetch([
      { path: '/quote', body: { expectedOut: '99', priceImpactBps: 1, poolFee: '1', spotPrice: '1.0000' } },
    ]);
    const solver = new SolverClient('http://solver.test///', { fetch });
    const quote = await solver.quote('0xIn', '0xOut', '100');
    expect(quote.expectedOut).toBe('99');
    expect(requests[0]!.url).toBe('http://solver.test/quote?tokenIn=0xIn&tokenOut=0xOut&amountIn=100');
  });

  it('POSTs the signed intent as JSON', async () => {
    const { fetch, requests } = fakeFetch([
      {
        method: 'POST',
        path: '/intent',
        status: 202,
        body: { intentId: '0xabc', status: 'pending', estimatedSettlement: 1 },
      },
    ]);
    const solver = new SolverClient('http://solver.test', { fetch });
    const intent = {
      vault: '0x1',
      sessionKey: '0x2',
      tokenIn: '0x3',
      tokenOut: '0x4',
      amountIn: '1',
      minAmountOut: '1',
      deadline: 5,
      nonce: 0,
      signature: '0x',
    };
    expect((await solver.submitIntent(intent)).intentId).toBe('0xabc');
    expect(requests[0]).toMatchObject({ method: 'POST', body: intent });
  });

  it('unwraps { pairs }', async () => {
    const { fetch } = fakeFetch([{ path: '/pairs', body: { pairs: [{ name: 'USDC/DAI' }] } }]);
    expect(await new SolverClient('http://s', { fetch }).pairs()).toEqual([{ name: 'USDC/DAI' }]);
  });

  it('turns error responses into SolverError with the server message and status', async () => {
    const { fetch } = fakeFetch([
      { method: 'POST', path: '/intent', status: 400, body: { error: 'deadline has passed' } },
      { path: '/status', status: 404, body: { error: 'unknown intent' } },
    ]);
    const solver = new SolverClient('http://s', { fetch });
    const err = await solver.submitIntent({} as never).catch((e) => e);
    expect(err).toBeInstanceOf(SolverError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/POST \/intent → 400: deadline has passed/);
    await expect(solver.status('0x1')).rejects.toMatchObject({ status: 404 });
  });

  it('reports network failures as status 0', async () => {
    const solver = new SolverClient('http://s', { fetch: async () => Promise.reject(new Error('ECONNREFUSED')) });
    await expect(solver.health()).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/ECONNREFUSED/) });
  });

  it('times out slow requests', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const solver = new SolverClient('http://s', { fetch: hang, timeoutMs: 20 });
    await expect(solver.health()).rejects.toThrow(/timed out after 20ms/);
  });

  it('rejects non-JSON success bodies', async () => {
    const solver = new SolverClient('http://s', { fetch: async () => new Response('<html>', { status: 200 }) });
    await expect(solver.health()).rejects.toThrow(/non-JSON/);
  });

  it('derives the WebSocket URL', () => {
    expect(new SolverClient('https://solver.archon.exchange/', { fetch: globalThis.fetch }).wsUrl()).toBe(
      'wss://solver.archon.exchange/ws',
    );
    expect(new SolverClient('http://localhost:3000', { fetch: globalThis.fetch }).wsUrl()).toBe(
      'ws://localhost:3000/ws',
    );
  });
});
