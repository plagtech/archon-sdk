import { ZeroAddress, getAddress, isAddress, type Contract, type Signer } from 'ethers';
import { agentVault, call, erc20, send, toTxReceipt, withNonceRetry } from './contracts/index.js';
import { chainTime, type ArchonContext } from './context.js';
import { ArchonError, ContractError } from './errors.js';
import { SessionKey } from './session.js';
import { generateSessionKey } from './signing/session.js';
import { toBigInt } from './tokens/amounts.js';
import { listTokens, resolveErc20Address, resolveTokenAddress } from './tokens/registry.js';
import type { SafetyConfig, SessionKeyConfig, SessionKeyInfo, SpendingState, TokenLike, TxReceipt } from './types.js';

export const DEFAULT_SESSION_KEY_TTL = 3600;
/** SafetyModule.MAX_CONFIGURABLE_SLIPPAGE_BPS */
const MAX_CONFIGURABLE_SLIPPAGE_BPS = 1000;

type OnChainSafetyConfig = Omit<SafetyConfig, 'allowedTokens'>;

/** Attach the client's provider to a signer that has none (e.g. `new Wallet(key)`) */
export function withProvider(signer: Signer, provider: ArchonContext['provider']): Signer {
  if (signer.provider) return signer;
  const connect = (signer as Signer & { connect?: (p: unknown) => Signer }).connect;
  if (typeof connect !== 'function') throw new ArchonError('Signer has no provider and cannot be connected to one');
  return connect.call(signer, provider);
}

/**
 * Same checks as SafetyModule._updateSafetyConfig, run locally so a bad config fails before
 * it costs gas. Returns the uint256 values in contract order.
 */
export function validateSafetyConfig(config: OnChainSafetyConfig) {
  const maxPerSwap = toBigInt(config.maxPerSwap, 'maxPerSwap');
  const maxPerWindow = toBigInt(config.maxPerWindow, 'maxPerWindow');
  const dailyCap = toBigInt(config.dailyCap, 'dailyCap');
  const int = (v: number, name: string) => {
    if (!Number.isSafeInteger(v) || v < 0) throw new ArchonError(`${name} must be a non-negative integer`);
    return BigInt(v);
  };
  const windowDuration = int(config.windowDuration, 'windowDuration');
  const maxSlippageBps = int(config.maxSlippageBps, 'maxSlippageBps');
  const cooldownPeriod = int(config.cooldownPeriod, 'cooldownPeriod');

  if (maxPerSwap === 0n) throw new ArchonError('maxPerSwap cannot be zero');
  if (maxPerWindow === 0n) throw new ArchonError('maxPerWindow cannot be zero');
  if (windowDuration === 0n) throw new ArchonError('windowDuration cannot be zero');
  if (maxSlippageBps === 0n || maxSlippageBps > BigInt(MAX_CONFIGURABLE_SLIPPAGE_BPS)) {
    throw new ArchonError(`maxSlippageBps must be 1–${MAX_CONFIGURABLE_SLIPPAGE_BPS}`);
  }
  if (dailyCap === 0n) throw new ArchonError('dailyCap cannot be zero');
  if (dailyCap < maxPerWindow) throw new ArchonError('dailyCap must be >= maxPerWindow');
  if (maxPerWindow < maxPerSwap) throw new ArchonError('maxPerWindow must be >= maxPerSwap');

  return { maxPerSwap, maxPerWindow, windowDuration, maxSlippageBps, dailyCap, cooldownPeriod };
}

/** An operator's AgentVault. Read methods work without a signer; operator methods need one. */
export class Vault {
  readonly address: string;
  readonly operator: string;
  private readonly signer: Signer | undefined;
  private signerChecked: Promise<Contract> | undefined;

  /** @internal Use ArchonClient.createVault / getVault / getMyVault */
  constructor(
    private readonly ctx: ArchonContext,
    address: string,
    operator: string,
    signer?: Signer,
  ) {
    this.address = getAddress(address);
    this.operator = getAddress(operator);
    this.signer = signer;
  }

  /** The same vault with a different signer (must be the operator for operator actions) */
  connect(signer: Signer): Vault {
    return new Vault(this.ctx, this.address, this.operator, withProvider(signer, this.ctx.provider));
  }

  private get reader(): Contract {
    return agentVault(this.address, this.ctx.provider);
  }

  /** The vault contract connected to the operator's signer; throws if there is none */
  private writer(): Promise<Contract> {
    this.signerChecked ??= (async () => {
      if (!this.signer)
        throw new ArchonError('This vault was loaded without a signer; use vault.connect(operatorSigner)');
      const address = getAddress(await this.signer.getAddress());
      if (address !== this.operator) {
        throw new ArchonError(`Signer ${address} is not the operator of vault ${this.address} (${this.operator})`);
      }
      return agentVault(this.address, this.signer);
    })();
    // Don't cache a failure
    this.signerChecked.catch(() => (this.signerChecked = undefined));
    return this.signerChecked;
  }

  // ─── Initialization ─────────────────────────────────────────────────────────

  async initialize(config: SafetyConfig): Promise<TxReceipt> {
    const values = validateSafetyConfig(config);
    const tokens = (config.allowedTokens ?? []).map((t) => resolveErc20Address(t, this.ctx.chainId));
    if (await this.isInitialized()) throw new ArchonError(`Vault ${this.address} is already initialized`);
    return send(await this.writer(), 'initialize', values, tokens);
  }

  isInitialized(): Promise<boolean> {
    return call<boolean>(this.reader, 'initialized');
  }

  // ─── Funds ──────────────────────────────────────────────────────────────────

  /**
   * Move tokens from the operator into the vault. Approves the vault for exactly `amount` first
   * if the current allowance is lower. 'ETH' sends native ether.
   */
  async deposit(token: TokenLike, amount: string): Promise<TxReceipt> {
    const value = toBigInt(amount, 'amount');
    if (value === 0n) throw new ArchonError('amount must be positive');
    const vault = await this.writer();
    const address = resolveTokenAddress(token, this.ctx.chainId);

    if (address === ZeroAddress) {
      try {
        const tx = await withNonceRetry(() => this.signer!.sendTransaction({ to: this.address, value }));
        const receipt = await tx.wait();
        if (!receipt) throw new ArchonError('ETH deposit transaction was dropped');
        return toTxReceipt(receipt);
      } catch (err) {
        if (err instanceof ArchonError) throw err;
        throw new ContractError(`ETH deposit failed: ${(err as Error).message}`, undefined, [], err);
      }
    }

    const tokenContract = erc20(address, this.signer!);
    const [balance, allowance] = await Promise.all([
      call<bigint>(tokenContract, 'balanceOf', this.operator),
      call<bigint>(tokenContract, 'allowance', this.operator, this.address),
    ]);
    if (balance < value) throw new ArchonError(`Operator balance ${balance} of ${token} is below ${value}`);
    if (allowance < value) await send(tokenContract, 'approve', this.address, value);
    return send(vault, 'deposit', address, value);
  }

  /** Withdraw to `to` (default: the operator). 'ETH' withdraws native ether. */
  async withdraw(token: TokenLike, amount: string, to?: string): Promise<TxReceipt> {
    const value = toBigInt(amount, 'amount');
    if (value === 0n) throw new ArchonError('amount must be positive');
    const recipient = to ?? this.operator;
    if (!isAddress(recipient)) throw new ArchonError(`Recipient is not an address: ${recipient}`);
    const address = resolveTokenAddress(token, this.ctx.chainId);
    const vault = await this.writer();
    return address === ZeroAddress
      ? send(vault, 'withdrawETH', value, recipient)
      : send(vault, 'withdraw', address, value, recipient);
  }

  /** Vault balance in base units. 'ETH' is the native balance. */
  async getBalance(token: TokenLike): Promise<string> {
    const address = resolveTokenAddress(token, this.ctx.chainId);
    return (await call<bigint>(this.reader, 'getBalance', address)).toString();
  }

  /** Balances of every built-in token, keyed by symbol */
  async getBalances(): Promise<Record<string, string>> {
    const tokens = listTokens(this.ctx.chainId);
    const balances = await Promise.all(tokens.map((t) => this.getBalance(t.address)));
    return Object.fromEntries(tokens.map((t, i) => [t.symbol, balances[i]!]));
  }

  // ─── Safety ─────────────────────────────────────────────────────────────────

  /** Change some safety parameters; the rest keep their current values */
  async updateSafetyConfig(changes: Partial<OnChainSafetyConfig>): Promise<TxReceipt> {
    if ('allowedTokens' in changes) {
      throw new ArchonError('updateSafetyConfig does not change the allowlist; use setTokenAllowed()');
    }
    const values = validateSafetyConfig({ ...(await this.getSafetyConfig()), ...changes });
    return send(await this.writer(), 'updateSafetyConfig', values);
  }

  async setTokenAllowed(token: TokenLike, allowed: boolean): Promise<TxReceipt> {
    return send(await this.writer(), 'setTokenAllowed', resolveErc20Address(token, this.ctx.chainId), allowed);
  }

  async isTokenAllowed(token: TokenLike): Promise<boolean> {
    return call<boolean>(this.reader, 'tokenAllowlist', resolveErc20Address(token, this.ctx.chainId));
  }

  /** Halt all agent activity immediately */
  async freeze(): Promise<TxReceipt> {
    return send(await this.writer(), 'emergencyFreeze');
  }

  /** Resume agent activity. Fails until cooldownPeriod has passed since the freeze. */
  async unfreeze(): Promise<TxReceipt> {
    const vault = await this.writer();
    const [frozenAt, cooldown, now] = await Promise.all([
      call<bigint>(this.reader, 'frozenAt'),
      call<bigint>(this.reader, 'cooldownPeriod'),
      chainTime(this.ctx.provider),
    ]);
    const unlocksAt = Number(frozenAt + cooldown);
    if ((await this.isFrozen()) && cooldown > 0n && now < unlocksAt) {
      throw new ArchonError(`Vault cooldown has ${unlocksAt - now}s left (unfreezes at ${unlocksAt})`);
    }
    return send(vault, 'unfreeze');
  }

  async getSafetyConfig(): Promise<OnChainSafetyConfig> {
    const c = await call<Record<string, bigint>>(this.reader, 'getSafetyConfig');
    return {
      maxPerSwap: c.maxPerSwap!.toString(),
      maxPerWindow: c.maxPerWindow!.toString(),
      windowDuration: Number(c.windowDuration),
      maxSlippageBps: Number(c.maxSlippageBps),
      dailyCap: c.dailyCap!.toString(),
      cooldownPeriod: Number(c.cooldownPeriod),
    };
  }

  async getSpendingState(): Promise<SpendingState> {
    const [dailySpent, windowSpent, dailyCap, maxPerWindow, frozen] = await call<
      [bigint, bigint, bigint, bigint, boolean]
    >(this.reader, 'getSpendingState');
    return {
      dailySpent: dailySpent.toString(),
      windowSpent: windowSpent.toString(),
      dailyCap: dailyCap.toString(),
      maxPerWindow: maxPerWindow.toString(),
      frozen,
    };
  }

  isFrozen(): Promise<boolean> {
    return call<boolean>(this.reader, 'frozen');
  }

  // ─── Session keys ───────────────────────────────────────────────────────────

  /**
   * Generate a session key (or use `key`), register it, and return a handle the agent trades
   * with. The generated private key is only in the returned SessionKey's signer — hand it to
   * the agent; the SDK does not persist it.
   */
  async createSessionKey(config: SessionKeyConfig = {}, key?: Signer): Promise<SessionKey> {
    const signer = key ? withProvider(key, this.ctx.provider) : generateSessionKey(this.ctx.provider);
    const address = getAddress(await signer.getAddress());
    await this.registerSessionKey(address, config);
    return new SessionKey(this.ctx, this, signer, await this.getSessionKeyInfo(address));
  }

  /**
   * Register a key by address only — for agents that generate their own key and never share it.
   * The agent then calls ArchonClient.useSessionKey(vault, key). Returns the registration receipt
   * (token-scope transactions, if any, follow it).
   */
  async registerSessionKey(address: string, config: SessionKeyConfig = {}): Promise<TxReceipt> {
    if (!isAddress(address)) throw new ArchonError(`Session key is not an address: ${address}`);
    const canSwap = config.canSwap ?? true;
    const canBatchSwap = config.canBatchSwap ?? true;
    const canCrossChainSwap = config.canCrossChainSwap ?? false;
    if (!canSwap && !canBatchSwap && !canCrossChainSwap)
      throw new ArchonError('Session key needs at least one permission');
    const override = toBigInt(config.maxPerSwapOverride ?? '0', 'maxPerSwapOverride');
    const expiresIn = config.expiresIn ?? DEFAULT_SESSION_KEY_TTL;
    if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0)
      throw new ArchonError('expiresIn must be a positive integer');
    const scope = (config.allowedTokens ?? []).map((t) => resolveErc20Address(t, this.ctx.chainId));

    const vault = await this.writer();
    if (override > 0n) {
      const { maxPerSwap } = await this.getSafetyConfig();
      if (override > BigInt(maxPerSwap)) {
        throw new ArchonError(`maxPerSwapOverride ${override} exceeds the vault's maxPerSwap ${maxPerSwap}`);
      }
    }
    const expiry = (await chainTime(this.ctx.provider)) + expiresIn;
    const receipt = await send(
      vault,
      'registerSessionKey',
      address,
      canSwap,
      canBatchSwap,
      canCrossChainSwap,
      override,
      expiry,
    );
    for (const token of scope) await send(vault, 'setKeyTokenScope', address, token, true);
    return receipt;
  }

  async revokeSessionKey(address: string): Promise<TxReceipt> {
    return send(await this.writer(), 'revokeSessionKey', getAddress(address));
  }

  async getSessionKeyInfo(address: string): Promise<SessionKeyInfo> {
    const key = getAddress(address);
    const k = await call<Record<string, bigint | boolean>>(this.reader, 'sessionKeys', key);
    return {
      address: key,
      active: k.active as boolean,
      canSwap: k.canSwap as boolean,
      canBatchSwap: k.canBatchSwap as boolean,
      canCrossChainSwap: k.canCrossChainSwap as boolean,
      maxPerSwapOverride: (k.maxPerSwapOverride as bigint).toString(),
      expiry: Number(k.expiry),
      nonce: Number(k.nonce),
      totalSpent: (k.totalSpent as bigint).toString(),
      registeredAt: Number(k.registeredAt),
    };
  }

  /** Every key ever registered on this vault (including revoked and expired ones) */
  async getSessionKeys(): Promise<SessionKeyInfo[]> {
    const count = Number(await call<bigint>(this.reader, 'getRegisteredKeyCount'));
    const addresses = await Promise.all(
      Array.from({ length: count }, (_, i) => call<string>(this.reader, 'registeredKeys', i)),
    );
    // A key revoked and registered again appears twice in registeredKeys
    const unique = [...new Set(addresses.map((a) => getAddress(a)))];
    return Promise.all(unique.map((a) => this.getSessionKeyInfo(a)));
  }

  /** Active and not expired (on-chain view) */
  async isKeyValid(address: string): Promise<boolean> {
    return call<boolean>(this.reader, 'isKeyValid', getAddress(address));
  }

  async getKeyNonce(address: string): Promise<number> {
    return Number(await call<bigint>(this.reader, 'getKeyNonce', getAddress(address)));
  }
}
