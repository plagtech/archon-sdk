import { JsonRpcProvider, ZeroAddress, getAddress, isAddress, type Signer } from 'ethers';
import { BASE_CHAIN_ID, resolveAddresses } from './contracts/addresses.js';
import { archonPool, archonRouter, call, agentVault, sendRaw, vaultFactory } from './contracts/index.js';
import { type ArchonContext } from './context.js';
import { ArchonError } from './errors.js';
import { EventStream } from './events.js';
import { SessionKey } from './session.js';
import { SolverClient } from './solver.js';
import { toBigInt } from './tokens/amounts.js';
import { findToken, resolveErc20Address } from './tokens/registry.js';
import type {
  ArchonConfig,
  ContractAddresses,
  PairInfo,
  PoolState,
  Quote,
  QuoteParams,
  SolverHealth,
  SolverStats,
  SubscribeFilter,
} from './types.js';
import { Vault, withProvider } from './vault.js';

/** Entry point: connects to the chain and the solver */
export class ArchonClient {
  readonly chainId: number;
  readonly addresses: ContractAddresses;
  readonly solver: SolverClient;
  private readonly ctx: ArchonContext;

  constructor(config: ArchonConfig) {
    if (!config.solverUrl) throw new ArchonError('solverUrl is required');
    if (!config.provider && !config.rpcUrl) throw new ArchonError('Pass rpcUrl or provider');
    this.chainId = config.chainId ?? BASE_CHAIN_ID;
    this.addresses = resolveAddresses(this.chainId, config.contracts);
    this.solver = new SolverClient(config.solverUrl, { timeoutMs: config.requestTimeoutMs, fetch: config.fetch });
    const provider =
      config.provider ??
      new JsonRpcProvider(config.rpcUrl, this.chainId, {
        staticNetwork: true,
        // Request caching hands back stale nonces and balances between back-to-back operator txs
        cacheTimeout: -1,
      });
    this.ctx = {
      provider,
      chainId: this.chainId,
      addresses: this.addresses,
      solver: this.solver,
      pollIntervalMs: config.pollIntervalMs ?? 1_000,
      WebSocket: config.WebSocket,
    };
  }

  get provider() {
    return this.ctx.provider;
  }

  // ─── Vaults ─────────────────────────────────────────────────────────────────

  /** Deploy a vault owned by `signer` (one per operator). The signer pays gas. */
  async createVault(signer: Signer): Promise<Vault> {
    const operator = withProvider(signer, this.ctx.provider);
    const operatorAddress = getAddress(await operator.getAddress());
    const factory = vaultFactory(this.addresses.vaultFactory, operator);

    const existing = await call<string>(factory, 'operatorVault', operatorAddress);
    if (existing !== ZeroAddress) {
      throw new ArchonError(`${operatorAddress} already has vault ${existing}; use getMyVault()`);
    }

    const receipt = await sendRaw(factory, 'createVault');
    for (const log of receipt.logs) {
      const parsed = factory.interface.parseLog(log);
      if (parsed?.name === 'VaultCreated') {
        return new Vault(this.ctx, getAddress(parsed.args.vault as string), operatorAddress, operator);
      }
    }
    throw new ArchonError(`createVault succeeded (${receipt.hash}) but emitted no VaultCreated event`);
  }

  /**
   * Load a vault by address. Pass the operator's signer to enable operator actions; without it
   * the vault is read-only.
   */
  async getVault(address: string, signer?: Signer): Promise<Vault> {
    if (!isAddress(address)) throw new ArchonError(`Not an address: ${address}`);
    const vaultAddress = getAddress(address);
    const isVault = await call<boolean>(
      vaultFactory(this.addresses.vaultFactory, this.ctx.provider),
      'isVault',
      vaultAddress,
    );
    if (!isVault) throw new ArchonError(`${vaultAddress} is not an Archon vault`);
    const operator = getAddress(await call<string>(agentVault(vaultAddress, this.ctx.provider), 'operator'));
    return new Vault(this.ctx, vaultAddress, operator, signer ? withProvider(signer, this.ctx.provider) : undefined);
  }

  /** The vault operated by `signer`, or null if it has none */
  async getMyVault(signer: Signer): Promise<Vault | null> {
    const operator = withProvider(signer, this.ctx.provider);
    const address = await call<string>(
      vaultFactory(this.addresses.vaultFactory, this.ctx.provider),
      'operatorVault',
      await operator.getAddress(),
    );
    return address === ZeroAddress ? null : this.getVault(address, operator);
  }

  /**
   * Attach to a session key from the agent side: the agent has only the key and the vault
   * address, never the operator's signer. Throws if the key is not active on the vault.
   */
  async useSessionKey(vaultAddress: string, sessionKey: Signer): Promise<SessionKey> {
    const vault = await this.getVault(vaultAddress);
    const signer = withProvider(sessionKey, this.ctx.provider);
    const info = await vault.getSessionKeyInfo(await signer.getAddress());
    if (!info.active) throw new ArchonError(`Session key ${info.address} is not active on vault ${vault.address}`);
    return new SessionKey(this.ctx, vault, signer, info);
  }

  // ─── Market data ────────────────────────────────────────────────────────────

  getPairs(): Promise<PairInfo[]> {
    return this.solver.pairs();
  }

  async getQuote(params: QuoteParams): Promise<Quote> {
    return this.solver.quote(
      resolveErc20Address(params.tokenIn, this.chainId),
      resolveErc20Address(params.tokenOut, this.chainId),
      toBigInt(params.amountIn, 'amountIn').toString(),
    );
  }

  /** Read a pool straight from chain. `pair` is "USDC/DAI" (symbols or addresses, either order). */
  async getPoolState(pair: string): Promise<PoolState> {
    const parts = pair.split('/');
    if (parts.length !== 2) throw new ArchonError(`Pair must look like "USDC/DAI", got "${pair}"`);
    const [a, b] = parts.map((p) => resolveErc20Address(p.trim(), this.chainId)) as [string, string];

    const pool = await call<string>(archonRouter(this.addresses.router, this.ctx.provider), 'getPool', a, b);
    if (pool === ZeroAddress) throw new ArchonError(`No Archon pool for ${pair}`);
    const contract = archonPool(pool, this.ctx.provider);
    const [token0, token1, balances, feeBps] = await Promise.all([
      call<string>(contract, 'token0'),
      call<string>(contract, 'token1'),
      call<bigint[]>(contract, 'getBalances'),
      call<bigint>(contract, 'feeBps'),
    ]);
    const spotPrice = await call<bigint>(contract, 'spotPrice', token0);
    const label = (t: string) => findToken(t, this.chainId)?.symbol ?? t;
    return {
      pair: `${label(token0)}/${label(token1)}`,
      pool: getAddress(pool),
      token0: getAddress(token0),
      token1: getAddress(token1),
      reserves: [balances[0]!.toString(), balances[1]!.toString()],
      feeBps: Number(feeBps),
      spotPrice: spotPrice.toString(),
    };
  }

  // ─── Events ─────────────────────────────────────────────────────────────────

  /** Open a WebSocket to the solver. Reconnects automatically until close(). */
  subscribe(filter: SubscribeFilter = {}): EventStream {
    return new EventStream(this.solver.wsUrl(), filter, { WebSocket: this.ctx.WebSocket });
  }

  // ─── Solver ─────────────────────────────────────────────────────────────────

  health(): Promise<SolverHealth> {
    return this.solver.health();
  }

  /** Not yet served by the solver (throws SolverError 404 until it is) */
  stats(): Promise<SolverStats> {
    return this.solver.stats();
  }
}
