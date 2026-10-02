import { getAddress, type Signer } from 'ethers';
import { nowSec, type ArchonContext } from './context.js';
import { ArchonError, SolverError } from './errors.js';
import { Intent, isTerminal } from './intent.js';
import { signIntent } from './signing/intent.js';
import { toBigInt } from './tokens/amounts.js';
import { resolveErc20Address } from './tokens/registry.js';
import type {
  IntentStatus,
  Quote,
  QuoteParams,
  SessionKeyInfo,
  SessionKeyPermissions,
  SwapParams,
  TxReceipt,
} from './types.js';
import type { Vault } from './vault.js';

export const DEFAULT_SLIPPAGE_BPS = 50;
export const DEFAULT_DEADLINE_SEC = 300;
const BPS = 10_000n;
/** Retries when another process holding the same key took the nonce first (solver 409) */
const NONCE_CONFLICT_RETRIES = 3;

/** Statuses whose nonce has been (or is about to be) consumed on-chain, or is held by a live intent */
const HOLDS_NONCE: ReadonlySet<IntentStatus> = new Set(['pending', 'matched', 'settling', 'settled', 'refunded']);

/**
 * Pick the next nonce: the smallest n ≥ the on-chain nonce that no live or consumed intent holds.
 * A nonce left by an expired/failed intent is reused — otherwise every later nonce would wait
 * forever, since the vault only accepts nonces in order.
 */
export function nextFreeNonce(onChainNonce: number, held: Iterable<number>): number {
  const taken = new Set(held);
  let n = onChainNonce;
  while (taken.has(n)) n++;
  return n;
}

/** An agent's trading handle: signs batch intents with the session key and submits them to the solver */
export class SessionKey {
  readonly address: string;
  readonly vault: Vault;
  readonly permissions: SessionKeyPermissions;
  /** The session key's signer. For generated keys, `signer.privateKey` is what you hand the agent. */
  readonly signer: Signer;
  private readonly expiry: number;
  /** Intents this handle submitted, by nonce, until their nonce is consumed on-chain */
  private readonly submitted = new Map<number, Intent>();

  /** @internal Use Vault.createSessionKey or ArchonClient.useSessionKey */
  constructor(
    private readonly ctx: ArchonContext,
    vault: Vault,
    signer: Signer,
    info: SessionKeyInfo,
  ) {
    this.address = getAddress(info.address);
    this.vault = vault;
    this.signer = signer;
    this.expiry = info.expiry;
    this.permissions = {
      canSwap: info.canSwap,
      canBatchSwap: info.canBatchSwap,
      canCrossChainSwap: info.canCrossChainSwap,
      maxPerSwapOverride: info.maxPerSwapOverride,
    };
  }

  /**
   * Sign a swap intent and submit it to the solver. Unless `minAmountOut` is given, it is derived
   * from a fresh solver quote minus `slippageBps`. Resolves once the solver has accepted the
   * intent; call `intent.waitForSettlement()` to wait for the on-chain fill.
   */
  async swap(params: SwapParams): Promise<Intent> {
    if (!this.permissions.canBatchSwap) {
      throw new ArchonError('Session key lacks canBatchSwap; solver-settled swaps require it');
    }
    if (this.timeUntilExpiry() <= 0) throw new ArchonError(`Session key ${this.address} expired at ${this.expiry}`);

    const tokenIn = resolveErc20Address(params.tokenIn, this.ctx.chainId);
    const tokenOut = resolveErc20Address(params.tokenOut, this.ctx.chainId);
    if (tokenIn === tokenOut) throw new ArchonError('tokenIn and tokenOut must differ');
    const amountIn = toBigInt(params.amountIn, 'amountIn');
    if (amountIn === 0n) throw new ArchonError('amountIn must be positive');
    const override = BigInt(this.permissions.maxPerSwapOverride);
    if (override > 0n && amountIn > override) {
      throw new ArchonError(`amountIn ${amountIn} exceeds this key's maxPerSwapOverride ${override}`);
    }

    const deadline = params.deadline ?? nowSec() + DEFAULT_DEADLINE_SEC;
    if (!Number.isSafeInteger(deadline) || deadline <= nowSec())
      throw new ArchonError('deadline must be in the future');

    const minAmountOut =
      params.minAmountOut !== undefined
        ? toBigInt(params.minAmountOut, 'minAmountOut')
        : await this.minOutFromQuote(tokenIn, tokenOut, amountIn, params.slippageBps ?? DEFAULT_SLIPPAGE_BPS);

    const conflicted = new Set<number>();
    for (let attempt = 0; ; attempt++) {
      const onChain = await this.onChainNonce();
      const nonce = nextFreeNonce(onChain, [...(await this.heldNonces(onChain)), ...conflicted]);
      const signed = await signIntent(
        this.signer,
        {
          vault: this.vault.address,
          tokenIn,
          tokenOut,
          amountIn: amountIn.toString(),
          minAmountOut: minAmountOut.toString(),
          deadline,
          nonce,
        },
        this.ctx.chainId,
      );
      try {
        const response = await this.ctx.solver.submitIntent(signed);
        const intent = new Intent(this.ctx, signed, response);
        this.submitted.set(nonce, intent);
        return intent;
      } catch (err) {
        // 409: a live intent elsewhere already holds this nonce (same key used by another process)
        if (err instanceof SolverError && err.status === 409 && attempt < NONCE_CONFLICT_RETRIES) {
          conflicted.add(nonce);
          continue;
        }
        throw err;
      }
    }
  }

  async getQuote(params: QuoteParams): Promise<Quote> {
    return this.ctx.solver.quote(
      resolveErc20Address(params.tokenIn, this.ctx.chainId),
      resolveErc20Address(params.tokenOut, this.ctx.chainId),
      toBigInt(params.amountIn, 'amountIn').toString(),
    );
  }

  /** The nonce the next swap() will use */
  async getNonce(): Promise<number> {
    const onChain = await this.onChainNonce();
    return nextFreeNonce(onChain, await this.heldNonces(onChain));
  }

  /** Revoke on-chain. Requires the operator's signer on the vault (not available agent-side). */
  revoke(): Promise<TxReceipt> {
    return this.vault.revokeSessionKey(this.address);
  }

  /** Active and not expired, per the vault */
  isValid(): Promise<boolean> {
    return this.vault.isKeyValid(this.address);
  }

  /** Unix seconds */
  expiresAt(): number {
    return this.expiry;
  }

  /** Seconds until expiry by the local clock (≤ 0 once expired) */
  timeUntilExpiry(): number {
    return this.expiry - nowSec();
  }

  private async minOutFromQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    slippageBps: number,
  ): Promise<bigint> {
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
      throw new ArchonError('slippageBps must be an integer in [0, 10000)');
    }
    const quote = await this.ctx.solver.quote(tokenIn, tokenOut, amountIn.toString());
    const expected = BigInt(quote.expectedOut);
    if (expected === 0n)
      throw new ArchonError('Quote returned zero output; amountIn is too small or the pool is empty');
    return (expected * (BPS - BigInt(slippageBps))) / BPS;
  }

  private onChainNonce(): Promise<number> {
    return this.vault.getKeyNonce(this.address);
  }

  /** Nonces held by intents this handle submitted, refreshing the status of any still in flight */
  private async heldNonces(onChain: number): Promise<number[]> {
    const entries = [...this.submitted.entries()];
    const statuses = await Promise.all(
      entries.map(async ([nonce, intent]) => {
        if (nonce < onChain) {
          this.submitted.delete(nonce); // consumed on-chain; no longer tracked
          return null;
        }
        if (isTerminal(intent.status)) return intent.status;
        try {
          return await intent.getStatus();
        } catch (err) {
          // Unknown to the solver (e.g. it restarted): the intent is gone, so is its claim on the nonce
          if (err instanceof SolverError && err.status === 404) return 'expired' as const;
          return intent.status; // transient error: assume it still holds the nonce
        }
      }),
    );
    return entries.filter((_, i) => statuses[i] && HOLDS_NONCE.has(statuses[i]!)).map(([nonce]) => nonce);
  }
}
