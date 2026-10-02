import { ArchonError } from './errors.js';
import type {
  BatchSettledEvent,
  CircuitBreakerEvent,
  IntentEvent,
  IntentSettledEvent,
  PriceChangeEvent,
  SolverEvent,
  SolverEventName,
  SubscribeFilter,
  WebSocketConstructor,
  WebSocketLike,
} from './types.js';

/** Payload type of each solver event */
export interface SolverEventMap {
  'intent.accepted': IntentEvent;
  'intent.matched': IntentEvent;
  'intent.settling': IntentEvent;
  'intent.settled': IntentSettledEvent;
  'intent.refunded': IntentEvent;
  'intent.expired': IntentEvent;
  'intent.failed': IntentEvent;
  'batch.settled': BatchSettledEvent;
  'pool.price': PriceChangeEvent;
  'vault.swapExecuted': Record<string, unknown>;
  'vault.swapBlocked': Record<string, unknown>;
  'vault.circuitBreaker': CircuitBreakerEvent;
  'vault.frozen': Record<string, unknown>;
  'vault.unfrozen': Record<string, unknown>;
}

/** Connection lifecycle events emitted locally by the stream */
export interface StreamLifecycleMap {
  /** Socket opened (fires again after each reconnect) */
  open: void;
  /** Server acknowledged the subscription filter */
  subscribed: { vaults: string[] | null; events: string[] | null };
  close: { code: number; reason: string };
  /** Socket errors and server-reported errors */
  error: unknown;
}

type Callback = (data: never, envelope: SolverEvent) => void;

export interface EventStreamOptions {
  WebSocket?: WebSocketConstructor;
  /** Reconnect after unexpected disconnects. Default: true */
  reconnect?: boolean;
  /** Upper bound for reconnect backoff. Default: 30s */
  maxBackoffMs?: number;
}

const OPEN = 1;
const INITIAL_BACKOFF_MS = 500;

async function defaultWebSocket(): Promise<WebSocketConstructor> {
  const global = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (global) return global;
  // Node 18–21 have no global WebSocket; `ws` is already a dependency of ethers
  const mod = (await import('ws')) as unknown as { WebSocket?: WebSocketConstructor; default?: WebSocketConstructor };
  const ctor = mod.WebSocket ?? mod.default;
  if (!ctor) throw new ArchonError('No WebSocket implementation found; pass one as config.WebSocket');
  return ctor;
}

/**
 * Real-time event stream from the solver (WS /ws). Listen with exact names ("intent.settled"),
 * prefix patterns ("intent.*") or "*". Reconnects with exponential backoff and re-sends the
 * subscription until close() is called.
 */
export class EventStream {
  private readonly listeners = new Map<string, Set<Callback>>();
  private socket: WebSocketLike | undefined;
  private closed = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly reconnect: boolean;
  private readonly maxBackoffMs: number;
  private readyResolvers: (() => void)[] = [];

  /** @internal Use ArchonClient.subscribe */
  constructor(
    readonly url: string,
    private filter: SubscribeFilter,
    private readonly options: EventStreamOptions = {},
  ) {
    this.reconnect = options.reconnect ?? true;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    void this.connect();
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  /** Resolves when the server has acknowledged the current subscription */
  ready(): Promise<void> {
    return new Promise((resolve) => this.readyResolvers.push(resolve));
  }

  on<K extends keyof SolverEventMap>(
    event: K,
    callback: (data: SolverEventMap[K], envelope: SolverEvent) => void,
  ): this;
  on<K extends keyof StreamLifecycleMap>(event: K, callback: (data: StreamLifecycleMap[K]) => void): this;
  on(event: '*' | `${string}.*`, callback: (data: Record<string, unknown>, envelope: SolverEvent) => void): this;
  on(event: string, callback: (data: never, envelope: SolverEvent) => void): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(callback as Callback);
    return this;
  }

  off(event: string, callback?: (...args: never[]) => void): this {
    if (callback) this.listeners.get(event)?.delete(callback as Callback);
    else this.listeners.delete(event);
    return this;
  }

  /** Replace the server-side filter */
  setFilter(filter: SubscribeFilter): void {
    this.filter = filter;
    this.sendSubscribe();
  }

  /** Stop the stream permanently */
  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, 'client closed');
    this.socket = undefined;
  }

  onIntentSettled(callback: (event: IntentSettledEvent) => void): this {
    return this.on('intent.settled', callback);
  }

  onBatchSettled(callback: (event: BatchSettledEvent) => void): this {
    return this.on('batch.settled', callback);
  }

  onCircuitBreaker(callback: (event: CircuitBreakerEvent) => void): this {
    return this.on('vault.circuitBreaker', callback);
  }

  onPriceChange(callback: (event: PriceChangeEvent) => void): this {
    return this.on('pool.price', callback);
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    let Ctor: WebSocketConstructor;
    try {
      Ctor = this.options.WebSocket ?? (await defaultWebSocket());
    } catch (err) {
      this.emitLocal('error', err);
      return;
    }
    if (this.closed) return;

    const socket = new Ctor(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.emitLocal('open', undefined);
      this.sendSubscribe();
    };
    socket.onmessage = (ev) => this.handleMessage(ev.data);
    socket.onerror = (ev) => this.emitLocal('error', ev);
    socket.onclose = (ev) => {
      if (this.socket === socket) this.socket = undefined;
      this.emitLocal('close', { code: ev.code, reason: ev.reason });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.reconnect) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private sendSubscribe(): void {
    if (!this.socket || this.socket.readyState !== OPEN) return;
    const message: Record<string, unknown> = { op: 'subscribe' };
    if (this.filter.vaults) message.vaults = this.filter.vaults;
    if (this.filter.events) message.events = this.filter.events;
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage(raw: unknown): void {
    let msg: { event?: string; data?: unknown; vault?: string; timestamp?: number };
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      this.emitLocal('error', new ArchonError('Received a non-JSON message from the solver'));
      return;
    }
    switch (msg.event) {
      case undefined:
      case 'hello':
      case 'pong':
        return;
      case 'subscribed':
        this.emitLocal('subscribed', msg.data);
        for (const resolve of this.readyResolvers.splice(0)) resolve();
        return;
      case 'error':
        this.emitLocal('error', new ArchonError(`Solver stream error: ${(msg.data as { message?: string })?.message}`));
        return;
    }

    const envelope = msg as SolverEvent;
    const name = envelope.event as string;
    const targets = [name, '*'];
    for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
      targets.push(name.slice(0, dot) + '.*');
    }
    for (const target of targets) {
      for (const cb of this.listeners.get(target) ?? []) this.safeCall(cb, envelope.data, envelope);
    }
  }

  private emitLocal(event: keyof StreamLifecycleMap, data: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) this.safeCall(cb, data, undefined);
  }

  private safeCall(cb: Callback, data: unknown, envelope: SolverEvent | undefined): void {
    try {
      (cb as (d: unknown, e?: SolverEvent) => void)(data, envelope);
    } catch {
      // A throwing listener must not break the stream
    }
  }
}

export type { SolverEventName };
