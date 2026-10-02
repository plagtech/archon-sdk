import { Interface, getAddress } from 'ethers';
import { IntentEngineAbi } from './contracts/index.js';
import { nowSec, sleep, type ArchonContext } from './context.js';
import { ArchonError, IntentFailedError, SolverError, TimeoutError } from './errors.js';
import type { IntentStatus, IntentStatusInfo, SettlementResult, SignedIntent, SubmitIntentResponse } from './types.js';

const TERMINAL: ReadonlySet<IntentStatus> = new Set(['settled', 'refunded', 'expired', 'failed']);
export const isTerminal = (status: IntentStatus) => TERMINAL.has(status);

/** Grace period after the deadline: a batch submitted just before it can still be mined */
const SETTLEMENT_GRACE_SEC = 60;

export type IntentEventName = Exclude<IntentStatus, 'pending'> | 'error';
type Listener = (info: IntentStatusInfo) => void;
type ErrorListener = (error: unknown) => void;

const engineInterface = new Interface(IntentEngineAbi);

/** A submitted intent. Tracks its lifecycle by polling the solver. */
export class Intent {
  readonly id: string;
  readonly vault: string;
  readonly sessionKey: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: string;
  readonly minAmountOut: string;
  /** Unix seconds */
  readonly deadline: number;
  readonly nonce: number;
  readonly signature: string;
  /** Unix seconds; the solver's estimate when it accepted the intent */
  readonly estimatedSettlement: number;
  /** Last status seen (updated by getStatus, waitForSettlement and on()) */
  status: IntentStatus;
  /** Last full status payload seen */
  lastInfo: IntentStatusInfo | undefined;

  private readonly listeners = new Map<IntentEventName, Set<Listener | ErrorListener>>();
  private watching = false;

  /** @internal Created by SessionKey.swap */
  constructor(
    private readonly ctx: ArchonContext,
    signed: SignedIntent,
    response: SubmitIntentResponse,
  ) {
    this.id = response.intentId;
    this.status = response.status;
    this.estimatedSettlement = response.estimatedSettlement;
    this.vault = signed.vault;
    this.sessionKey = signed.sessionKey;
    this.tokenIn = signed.tokenIn;
    this.tokenOut = signed.tokenOut;
    this.amountIn = signed.amountIn;
    this.minAmountOut = signed.minAmountOut;
    this.deadline = signed.deadline;
    this.nonce = signed.nonce;
    this.signature = signed.signature;
  }

  /** Fetch the current status from the solver */
  async getStatus(): Promise<IntentStatus> {
    return (await this.getStatusInfo()).status;
  }

  /** Fetch the full status payload (expected/actual output, tx hash, exclusion reason) */
  async getStatusInfo(): Promise<IntentStatusInfo> {
    const info = await this.ctx.solver.status(this.id);
    this.update(info);
    return info;
  }

  /**
   * Resolve once the intent settles on-chain. Rejects with IntentFailedError if it is refunded,
   * expires or fails, and with TimeoutError after `timeoutMs` (default: until the deadline plus
   * a minute).
   */
  async waitForSettlement(timeoutMs?: number): Promise<SettlementResult> {
    const limitMs = timeoutMs ?? Math.max(30, this.deadline - nowSec() + SETTLEMENT_GRACE_SEC) * 1000;
    const giveUpAt = Date.now() + limitMs;
    for (;;) {
      const info = await this.getStatusInfo();
      if (info.status === 'settled') return this.settlementResult(info);
      if (isTerminal(info.status)) {
        throw new IntentFailedError(this.id, info.status as Exclude<IntentStatus, 'settled'>, info);
      }
      if (Date.now() + this.ctx.pollIntervalMs > giveUpAt) {
        throw new TimeoutError(`Intent ${this.id} still ${info.status} after ${limitMs}ms`);
      }
      await sleep(this.ctx.pollIntervalMs);
    }
  }

  /**
   * Listen for lifecycle changes. Polling starts with the first listener and stops at a terminal
   * status. Polling errors go to 'error' listeners (and polling continues).
   */
  on(event: Exclude<IntentEventName, 'error'>, callback: Listener): this;
  on(event: 'error', callback: ErrorListener): this;
  on(event: IntentEventName, callback: Listener | ErrorListener): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(callback);
    if (!this.watching && !isTerminal(this.status)) void this.watch();
    return this;
  }

  off(event: IntentEventName, callback?: Listener | ErrorListener): this {
    if (callback) this.listeners.get(event)?.delete(callback);
    else this.listeners.delete(event);
    return this;
  }

  private update(info: IntentStatusInfo): void {
    const previous = this.status;
    this.status = info.status;
    this.lastInfo = info;
    if (info.status !== previous && info.status !== 'pending') this.emit(info.status, info);
  }

  private emit(event: IntentEventName, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) {
      try {
        (cb as (p: unknown) => void)(payload);
      } catch {
        // A throwing listener must not stop the poller
      }
    }
  }

  private hasListeners(): boolean {
    for (const [event, set] of this.listeners) if (event !== 'error' && set.size > 0) return true;
    return false;
  }

  private async watch(): Promise<void> {
    this.watching = true;
    try {
      while (this.hasListeners() && !isTerminal(this.status)) {
        try {
          await this.getStatusInfo();
        } catch (err) {
          this.emit('error', err);
          // An intent the solver no longer knows will never change again
          if (err instanceof SolverError && err.status === 404) return;
        }
        if (!isTerminal(this.status)) await sleep(this.ctx.pollIntervalMs);
      }
    } finally {
      this.watching = false;
    }
  }

  /** Combine the solver's view with the batch transaction's logs */
  private async settlementResult(info: IntentStatusInfo): Promise<SettlementResult> {
    if (!info.txHash) throw new ArchonError(`Intent ${this.id} is settled but the solver reported no txHash`);
    const receipt = await this.ctx.provider.getTransactionReceipt(info.txHash);
    if (!receipt) throw new ArchonError(`Settlement transaction ${info.txHash} not found on chain`);

    const engine = getAddress(this.ctx.addresses.intentEngine);
    let amountOut = info.amountOut;
    let batch: { tokenA: string; sellA: bigint; sellB: bigint; residualIn: bigint; residualIsA: boolean } | undefined;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== engine) continue;
      const parsed = engineInterface.parseLog(log);
      if (!parsed) continue;
      if (
        parsed.name === 'IntentFilled' &&
        getAddress(parsed.args.vault as string) === this.vault &&
        getAddress(parsed.args.sessionKey as string) === this.sessionKey &&
        Number(parsed.args.nonce) === this.nonce
      ) {
        amountOut = (parsed.args.amountOut as bigint).toString();
      } else if (parsed.name === 'BatchSettled') {
        batch = {
          tokenA: getAddress(parsed.args.tokenA as string),
          sellA: parsed.args.sellA as bigint,
          sellB: parsed.args.sellB as bigint,
          residualIn: parsed.args.residualIn as bigint,
          residualIsA: parsed.args.residualIsA as boolean,
        };
      }
    }
    if (amountOut === undefined) throw new ArchonError(`No output recorded for intent ${this.id} in ${info.txHash}`);

    // Only the excess side of the batch goes through the pool, split pro-rata across that side
    const amountIn = BigInt(this.amountIn);
    let poolAmount = 0n;
    if (batch) {
      const sellsA = this.tokenIn === batch.tokenA;
      const sideTotal = sellsA ? batch.sellA : batch.sellB;
      if (sellsA === batch.residualIsA && sideTotal > 0n) poolAmount = (amountIn * batch.residualIn) / sideTotal;
    }
    const matchedAmount = amountIn - poolAmount;

    return {
      intentId: this.id,
      amountOut,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      batchId: info.batchId ?? '',
      matched: matchedAmount > 0n,
      poolAmount: poolAmount.toString(),
      matchedAmount: matchedAmount.toString(),
      gasCost: (receipt.gasUsed * receipt.gasPrice).toString(),
    };
  }
}
