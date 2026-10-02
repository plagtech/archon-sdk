import { Interface, getAddress, type InterfaceAbi, type Provider } from 'ethers';
import { SolverClient } from '../../src/solver.js';
import type { ArchonContext } from '../../src/context.js';
import { DEFAULT_ADDRESSES } from '../../src/contracts/addresses.js';
import type { WebSocketLike } from '../../src/types.js';

type Handler = (...args: never[]) => unknown;

/**
 * A provider that answers eth_call by decoding calldata with real ABIs and encoding whatever the
 * registered handler returns. Enough for every read path in the SDK, with no node.
 */
export class FakeChain {
  private readonly contracts = new Map<string, { iface: Interface; handlers: Record<string, Handler> }>();
  readonly calls: { to: string; method: string; args: unknown[] }[] = [];
  timestamp = 1_800_000_000;
  receipts = new Map<string, unknown>();

  register(address: string, abi: InterfaceAbi, handlers: Record<string, Handler>): this {
    this.contracts.set(getAddress(address), { iface: new Interface(abi), handlers });
    return this;
  }

  /** Replace or add handlers on an already-registered contract */
  patch(address: string, handlers: Record<string, Handler>): this {
    Object.assign(this.contracts.get(getAddress(address))!.handlers, handlers);
    return this;
  }

  get provider(): Provider {
    return {
      provider: null,
      call: async (tx: { to: string; data: string }) => {
        const contract = this.contracts.get(getAddress(tx.to));
        if (!contract) throw new Error(`FakeChain: no contract at ${tx.to}`);
        const parsed = contract.iface.parseTransaction({ data: tx.data });
        if (!parsed) throw new Error(`FakeChain: cannot decode call to ${tx.to}`);
        const handler = contract.handlers[parsed.name];
        if (!handler) throw new Error(`FakeChain: no handler for ${parsed.name} at ${tx.to}`);
        this.calls.push({ to: tx.to, method: parsed.name, args: [...parsed.args] });
        const result = (handler as (...a: unknown[]) => unknown)(...parsed.args);
        const outputs = parsed.fragment.outputs.length === 1 ? [result] : (result as unknown[]);
        return contract.iface.encodeFunctionResult(parsed.fragment, outputs);
      },
      getBlock: async () => ({ timestamp: this.timestamp }),
      getTransactionReceipt: async (hash: string) => this.receipts.get(hash) ?? null,
      resolveName: async (name: string) => name,
    } as unknown as Provider;
  }
}

export interface FakeRoute {
  method?: 'GET' | 'POST';
  /** Path prefix, e.g. "/quote" */
  path: string;
  status?: number;
  body: unknown | ((req: { url: string; body: unknown }) => unknown);
}

export interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

/** fetch that serves canned JSON by path. Routes are matched first to last; unmatched paths 404. */
export function fakeFetch(routes: FakeRoute[]) {
  const requests: RecordedRequest[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({ method, url, body });
    const path = new URL(url).pathname;
    const route = routes.find((r) => (r.method ?? method) === method && path.startsWith(r.path));
    if (!route) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const payload =
      typeof route.body === 'function' ? (route.body as (r: unknown) => unknown)({ url, body }) : route.body;
    return new Response(JSON.stringify(payload), { status: route.status ?? 200 });
  };
  return { fetch, requests };
}

export function fakeContext(chain: FakeChain, fetch: ReturnType<typeof fakeFetch>['fetch']): ArchonContext {
  return {
    provider: chain.provider,
    chainId: 8453,
    addresses: { ...DEFAULT_ADDRESSES[8453]! },
    solver: new SolverClient('http://solver.test', { fetch }),
    pollIntervalMs: 5,
  };
}

/** In-memory WebSocket. Tests drive it with serverOpen / serverSend / serverClose. */
export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverSend(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}
