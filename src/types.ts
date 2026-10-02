/**
 * Public types for the Archon SDK.
 *
 * Conventions:
 * - Token amounts are decimal strings in base units ("1000000" = 1 USDC). Never JS numbers.
 * - Durations and timestamps are seconds (numbers are safe; they stay far below 2^53).
 * - Addresses are checksummed when returned by the SDK; any casing is accepted as input.
 */

import type { Provider } from 'ethers';

// ─── Tokens ─────────────────────────────────────────────────────────────────

/** Built-in token symbols on Base. 'ETH' is native ether (address(0)), not WETH. */
export type TokenSymbol = 'USDC' | 'USDT' | 'DAI' | 'WETH' | 'ETH';

/** A token symbol or a raw address */
export type TokenLike = TokenSymbol | string;

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
  /** True for native ether, which vaults can hold but pools cannot trade */
  native?: boolean;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface ContractAddresses {
  router: string;
  vaultFactory: string;
  intentEngine: string;
  spraayAdapter: string;
  crossChainEscrow: string;
}

export interface ArchonConfig {
  /** JSON-RPC endpoint. Optional if `provider` is given. */
  rpcUrl?: string;
  solverUrl: string;
  /** Default: 8453 (Base) */
  chainId?: number;
  /** Override the default deployment addresses for the chain */
  contracts?: Partial<ContractAddresses>;
  /** Use an existing ethers provider instead of creating one from rpcUrl */
  provider?: Provider;
  /** Custom fetch for solver HTTP calls. Default: globalThis.fetch */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** WebSocket constructor for EventStream. Default: globalThis.WebSocket, else the `ws` package */
  WebSocket?: WebSocketConstructor;
  /** Solver HTTP timeout. Default: 15000 */
  requestTimeoutMs?: number;
  /** How often Intent polls GET /status. Default: 1000 */
  pollIntervalMs?: number;
}

/** Minimal WebSocket surface the SDK uses (satisfied by browsers, Node 22+, and the `ws` package) */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

// ─── Vault ──────────────────────────────────────────────────────────────────

/** Mirrors IAgentVault.SafetyConfig, plus the initial allowlist used by initialize() */
export interface SafetyConfig {
  /** Max single swap, base units */
  maxPerSwap: string;
  /** Max cumulative spend per rolling window, base units */
  maxPerWindow: string;
  /** Rolling window length, seconds */
  windowDuration: number;
  /** Max tolerable slippage, basis points (1–1000) */
  maxSlippageBps: number;
  /** Hard daily ceiling, base units */
  dailyCap: string;
  /** Minimum freeze duration before the operator can unfreeze, seconds */
  cooldownPeriod: number;
  /**
   * Tokens to allowlist (symbols or addresses). Used by initialize(). Not returned by
   * getSafetyConfig(): the on-chain allowlist is a mapping and cannot be enumerated.
   */
  allowedTokens?: TokenLike[];
}

/** AgentVault.getSpendingState() */
export interface SpendingState {
  dailySpent: string;
  windowSpent: string;
  dailyCap: string;
  maxPerWindow: string;
  frozen: boolean;
}

/** Contract receipt summary returned by every state-changing call */
export interface TxReceipt {
  hash: string;
  blockNumber: number;
  status: 'success' | 'reverted';
  gasUsed: string;
}

// ─── Session keys ───────────────────────────────────────────────────────────

export interface SessionKeyConfig {
  /** Single swaps via AgentVault.submitSwapIntent. Default: true */
  canSwap?: boolean;
  /** Batch intents settled by the solver via IntentEngine. Default: true. Required for swap(). */
  canBatchSwap?: boolean;
  /** Default: false */
  canCrossChainSwap?: boolean;
  /** Per-key per-swap cap, base units. "0" = use the vault's maxPerSwap. Default: "0" */
  maxPerSwapOverride?: string;
  /** Lifetime in seconds from now (chain time). Default: 3600 */
  expiresIn?: number;
  /**
   * Restrict this key to these tokens (both tokenIn and tokenOut must be listed), on top of the
   * vault allowlist. Default: no per-key scope. Each token is one extra setKeyTokenScope transaction.
   */
  allowedTokens?: TokenLike[];
}

export interface SessionKeyPermissions {
  canSwap: boolean;
  canBatchSwap: boolean;
  canCrossChainSwap: boolean;
  maxPerSwapOverride: string;
}

/** On-chain state of a session key (AgentVault.sessionKeys(key)) */
export interface SessionKeyInfo extends SessionKeyPermissions {
  address: string;
  active: boolean;
  /** Unix seconds */
  expiry: number;
  nonce: number;
  totalSpent: string;
  /** Unix seconds */
  registeredAt: number;
}

// ─── Intents ────────────────────────────────────────────────────────────────

export interface SwapParams {
  tokenIn: TokenLike;
  tokenOut: TokenLike;
  /** Base units */
  amountIn: string;
  /** Slippage tolerance applied to the solver quote to derive minAmountOut. Default: 50 (0.5%) */
  slippageBps?: number;
  /** Explicit minimum output in base units. Overrides slippageBps; skips the quote. */
  minAmountOut?: string;
  /** Unix seconds. Default: now + 300 */
  deadline?: number;
}

/**
 * The fields a session key signs for a batch intent. Field names match the solver's
 * POST /intent body and AgentVault.executeBatchLeg parameters.
 */
export interface IntentMessage {
  vault: string;
  tokenIn: string;
  tokenOut: string;
  /** Base units */
  amountIn: string;
  /** Base units */
  minAmountOut: string;
  /** Unix seconds */
  deadline: number;
  nonce: number;
}

/** An intent plus the session key that signed it — the exact POST /intent body */
export interface SignedIntent extends IntentMessage {
  sessionKey: string;
  /** 65-byte hex signature (r ‖ s ‖ v, v ∈ {27, 28}) */
  signature: string;
}

/** Matches the solver's lifecycle states */
export type IntentStatus = 'pending' | 'matched' | 'settling' | 'settled' | 'refunded' | 'expired' | 'failed';

/** GET /status/:intentId */
export interface IntentStatusInfo {
  intentId: string;
  status: IntentStatus;
  vault: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  deadline: number;
  /** Output the solver expects in its current batch plan */
  expectedOut?: string;
  /** Output delivered on-chain, once settled */
  amountOut?: string;
  batchId?: string;
  txHash?: string;
  /** Why the intent was last excluded from a batch, if it was */
  reason?: string;
}

/** POST /intent response */
export interface SubmitIntentResponse {
  intentId: string;
  status: IntentStatus;
  /** Unix seconds */
  estimatedSettlement: number;
}

export interface SettlementResult {
  intentId: string;
  amountOut: string;
  txHash: string;
  blockNumber: number;
  batchId: string;
  /** True if any of amountIn was matched peer-to-peer rather than routed through the pool */
  matched: boolean;
  /** Portion of amountIn routed through the pool (pro-rata share of the batch residual) */
  poolAmount: string;
  /** Portion of amountIn matched directly against opposing intents */
  matchedAmount: string;
  /** Gas cost of the whole batch transaction in wei (paid by the solver, shared by all legs) */
  gasCost: string;
}

// ─── Market data ────────────────────────────────────────────────────────────

export interface QuoteParams {
  tokenIn: TokenLike;
  tokenOut: TokenLike;
  /** Base units */
  amountIn: string;
}

/** GET /quote */
export interface Quote {
  expectedOut: string;
  priceImpactBps: number;
  poolFee: string;
  /** Human-readable price of tokenIn in tokenOut */
  spotPrice: string;
}

/** An entry of GET /pairs */
export interface PairInfo {
  /** e.g. "USDC/DAI" */
  name: string;
  pool: string;
  type: 'stable' | 'volatile';
  tokens: { symbol: string; address: string; decimals: number }[];
  feeBps: number;
  /** Pool reserves by token symbol, base units */
  liquidity: Record<string, string>;
  /** Price of the second token in the first, e.g. WETH in USDC for "USDC/WETH" */
  spotPrice: string;
}

/** Pool state read directly from chain */
export interface PoolState {
  pair: string;
  pool: string;
  token0: string;
  token1: string;
  /** Reserves in base units, indexed like token0/token1 */
  reserves: [string, string];
  feeBps: number;
  /** spotPrice(token0) as returned by the pool: token1 per token0, 1e18-scaled */
  spotPrice: string;
}

/** GET /health */
export interface SolverHealth {
  status: string;
  chain: number;
  solverAddress: string;
  pendingIntents: number;
  /** ISO timestamp, or null if no batch has settled since the solver started */
  lastSettlement: string | null;
  poolPrices: Record<string, string>;
  /** Seconds */
  uptime: number;
}

/**
 * GET /stats. In-memory counters since the solver process started (they reset on restart).
 * Amounts are base-unit decimal strings; rates are fractions in [0, 1].
 * Batch, gas and volume figures are recorded from the solver's own settlement receipts, so they
 * can trail intent statuses (which come from chain logs) by a few seconds.
 * Mirrors SolverStats in archon-solver/src/stats.ts — keep the two in sync.
 */
export interface SolverStats {
  solver: { address: string; chainId: number };
  uptime: {
    /** ISO timestamp of process start */
    startedAt: string;
    /** ISO timestamp of this response */
    now: string;
    seconds: number;
  };
  intents: {
    /** Accepted by POST /intent (rejected submissions are not counted) */
    received: number;
    settled: number;
    /** Settled intents filled at least partly peer-to-peer (coincidence of wants) */
    matched: number;
    /** Settled intents filled at least partly through the pool (one split between both counts in both) */
    routedThroughPool: number;
    refunded: number;
    expired: number;
    failed: number;
  };
  mempool: {
    /** Waiting to be batched */
    pending: number;
    /** In a batch being submitted or awaiting confirmation */
    inFlight: number;
    /** Every configured pair, by pair name */
    byPair: Record<string, { pending: number; inFlight: number }>;
  };
  volume: {
    /** CoW volume / settled volume across all pairs; null until something settles, or if pairs use different quote tokens */
    matchRate: number | null;
    /** Volumes in the pair's quote token (its first symbol, e.g. USDC for "USDC/DAI") at each batch's clearing price */
    byPair: Record<
      string,
      { quoteToken: string; settled: string; matched: string; routedThroughPool: string; matchRate: number | null }
    >;
  };
  settlement: {
    /** settleBatch transactions broadcast by this solver */
    batchesSubmitted: number;
    batchesSettled: number;
    /** Mined but reverted (no intent filled; gas still spent) */
    batchesReverted: number;
    gasUsed: string;
    /** gasUsed × effective gas price, wei */
    gasSpentWei: string;
    /** ISO timestamp of the last confirmed batch */
    lastSettlement: string | null;
    /** Mean time from submission to settlement */
    averageSettlementMs: number | null;
  };
}

// ─── Events ─────────────────────────────────────────────────────────────────

export type SolverEventName =
  | 'intent.accepted'
  | 'intent.matched'
  | 'intent.settling'
  | 'intent.settled'
  | 'intent.refunded'
  | 'intent.expired'
  | 'intent.failed'
  | 'batch.settled'
  | 'pool.price'
  | 'vault.swapExecuted'
  | 'vault.swapBlocked'
  | 'vault.circuitBreaker'
  | 'vault.frozen'
  | 'vault.unfrozen';

export interface SubscribeFilter {
  /** Only vault-scoped events (intent.*, vault.*) for these vaults. Default: all */
  vaults?: string[];
  /** Event names or "prefix.*" patterns. Default: all */
  events?: (SolverEventName | `${string}.*`)[];
}

/** Envelope of every message on WS /ws */
export interface SolverEvent<T = Record<string, unknown>> {
  event: SolverEventName;
  data: T;
  /** Set on vault-scoped events */
  vault?: string;
  /** Unix milliseconds */
  timestamp: number;
}

/** Payload of every intent.* event */
export interface IntentEvent {
  intentId: string;
  status: IntentStatus;
  vault: string;
  sessionKey: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  nonce: number;
  expectedOut?: string;
  amountOut?: string;
  txHash?: string;
  batchId?: string;
  reason?: string;
}

export type IntentSettledEvent = IntentEvent & { status: 'settled'; amountOut: string; txHash: string };

export interface BatchSettledEvent {
  batchId: string;
  pair: string;
  tokenA: string;
  tokenB: string;
  /** Intents that received output */
  count: string;
  /** Amount sold on each side, by token symbol */
  volume: Record<string, string>;
  /** Clearing price, tokenB per tokenA, 1e18-scaled */
  price: string;
  residualIn: string;
  residualOut: string;
  residualToken: string;
  txHash: string;
  blockNumber: number;
}

export interface CircuitBreakerEvent {
  vault: string;
  reason: string;
  /** Unix seconds */
  timestamp: string;
  sessionKey: string;
  txHash: string;
  blockNumber: number;
}

export interface PriceChangeEvent {
  pair: string;
  pool: string;
  price: string;
  previous?: string;
  /** null on the first reading */
  changeBps: number | null;
}
