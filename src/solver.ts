import { SolverError } from './errors.js';
import type {
  IntentStatusInfo,
  PairInfo,
  Quote,
  SignedIntent,
  SolverHealth,
  SolverStats,
  SubmitIntentResponse,
} from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SolverClientOptions {
  /** Per-request timeout. Default: 15s */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). Default: globalThis.fetch */
  fetch?: FetchLike;
}

/**
 * Thin HTTP client for the solver API. Request/response shapes match
 * archon-solver/src/api/routes.ts. Amounts stay decimal strings end to end.
 */
export class SolverClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, options: SolverClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error('No fetch implementation available; pass one in the config (Node 18+ has it built in)');
    this.fetchImpl = f;
  }

  submitIntent(intent: SignedIntent): Promise<SubmitIntentResponse> {
    return this.request('POST', '/intent', intent);
  }

  quote(tokenIn: string, tokenOut: string, amountIn: string): Promise<Quote> {
    const query = new URLSearchParams({ tokenIn, tokenOut, amountIn });
    return this.request('GET', `/quote?${query}`);
  }

  async pairs(): Promise<PairInfo[]> {
    return (await this.request<{ pairs: PairInfo[] }>('GET', '/pairs')).pairs;
  }

  status(intentId: string): Promise<IntentStatusInfo> {
    return this.request('GET', `/status/${encodeURIComponent(intentId)}`);
  }

  health(): Promise<SolverHealth> {
    return this.request('GET', '/health');
  }

  stats(): Promise<SolverStats> {
    return this.request('GET', '/stats');
  }

  /** ws:// or wss:// URL of the event stream */
  wsUrl(): string {
    return this.baseUrl.replace(/^http/, 'ws') + '/ws';
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = controller.signal.aborted ? `timed out after ${this.timeoutMs}ms` : (err as Error).message;
      throw new SolverError(`Solver request ${method} ${path} failed: ${reason}`, 0, path);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const message = (parsed as { error?: string } | undefined)?.error ?? (text.slice(0, 200) || res.statusText);
      throw new SolverError(`Solver ${method} ${path.split('?')[0]} → ${res.status}: ${message}`, res.status, path);
    }
    if (parsed === undefined)
      throw new SolverError(`Solver ${method} ${path} returned a non-JSON body`, res.status, path);
    return parsed as T;
  }
}
