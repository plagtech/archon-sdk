import { getAddress } from 'ethers';
import { describe, expect, it } from 'vitest';
import { ArchonClient } from '../src/client.js';
import { BASE_POOLS, DEFAULT_ADDRESSES } from '../src/contracts/addresses.js';
import { AgentVaultAbi, ArchonRouterAbi, StablePoolAbi, VaultFactoryAbi } from '../src/contracts/index.js';
import { ArchonError } from '../src/errors.js';
import { resolveTokenAddress } from '../src/tokens/registry.js';
import type { SolverStats } from '../src/types.js';
import { FakeChain, fakeFetch } from './helpers/fakes.js';

const A = DEFAULT_ADDRESSES[8453]!;
const USDC = resolveTokenAddress('USDC');
const DAI = resolveTokenAddress('DAI');
const VAULT = getAddress('0x00000000000000000000000000000000000000aa');
const OPERATOR = getAddress('0x00000000000000000000000000000000000000bb');

function client(chain = new FakeChain(), routes: Parameters<typeof fakeFetch>[0] = []) {
  const f = fakeFetch(routes);
  return {
    archon: new ArchonClient({ provider: chain.provider, solverUrl: 'http://solver.test', fetch: f.fetch }),
    ...f,
  };
}

describe('ArchonClient config', () => {
  it('requires solverUrl and rpcUrl/provider', () => {
    expect(() => new ArchonClient({ solverUrl: '' } as never)).toThrow(/solverUrl/);
    expect(() => new ArchonClient({ solverUrl: 'http://s' })).toThrow(/rpcUrl or provider/);
  });

  it('defaults to Base and applies contract overrides', () => {
    const archon = new ArchonClient({
      rpcUrl: 'http://rpc',
      solverUrl: 'http://s',
      contracts: { router: '0x0000000000000000000000000000000000000001' },
    });
    expect(archon.chainId).toBe(8453);
    expect(archon.addresses.router).toBe('0x0000000000000000000000000000000000000001');
    expect(archon.addresses.vaultFactory).toBe(A.vaultFactory);
  });

  it('demands full addresses on unknown chains', () => {
    expect(() => new ArchonClient({ rpcUrl: 'http://rpc', solverUrl: 'http://s', chainId: 1 })).toThrow(
      /No Archon deployment known for chain 1/,
    );
  });
});

describe('market data', () => {
  it('getQuote resolves symbols to addresses', async () => {
    const { archon, requests } = client(new FakeChain(), [
      { path: '/quote', body: { expectedOut: '999', priceImpactBps: 2, poolFee: '4', spotPrice: '0.9990' } },
    ]);
    const quote = await archon.getQuote({ tokenIn: 'USDC', tokenOut: 'dai', amountIn: '1000000' });
    expect(quote.expectedOut).toBe('999');
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get('tokenIn')).toBe(USDC);
    expect(url.searchParams.get('tokenOut')).toBe(DAI);
  });

  it('getQuote rejects bad amounts and native ETH before calling the solver', async () => {
    const { archon, requests } = client();
    await expect(archon.getQuote({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: '1.5' })).rejects.toThrow(
      /integer string/,
    );
    await expect(archon.getQuote({ tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '1' })).rejects.toThrow(/use WETH/);
    expect(requests).toHaveLength(0);
  });

  it('getPairs / health / stats pass through', async () => {
    // Typed as SolverStats so a drift between this fixture and the type fails typecheck
    const stats: SolverStats = {
      solver: { address: OPERATOR, chainId: 8453 },
      uptime: { startedAt: '2026-10-01T12:00:00.000Z', now: '2026-10-01T12:01:00.000Z', seconds: 60 },
      intents: { received: 3, settled: 2, matched: 2, routedThroughPool: 1, refunded: 0, expired: 1, failed: 0 },
      mempool: { pending: 0, inFlight: 0, byPair: { 'USDC/DAI': { pending: 0, inFlight: 0 } } },
      volume: {
        matchRate: 0.666666,
        byPair: {
          'USDC/DAI': {
            quoteToken: 'USDC',
            settled: '150000000',
            matched: '100000000',
            routedThroughPool: '50000000',
            matchRate: 0.666666,
          },
        },
      },
      settlement: {
        batchesSubmitted: 1,
        batchesSettled: 1,
        batchesReverted: 0,
        gasUsed: '200000',
        gasSpentWei: '600000',
        lastSettlement: '2026-10-01T12:00:30.000Z',
        averageSettlementMs: 4000,
      },
    };
    const { archon } = client(new FakeChain(), [
      { path: '/pairs', body: { pairs: [{ name: 'USDC/DAI' }] } },
      { path: '/health', body: { status: 'ok', chain: 8453 } },
      { path: '/stats', body: stats },
    ]);
    expect((await archon.getPairs())[0]!.name).toBe('USDC/DAI');
    expect((await archon.health()).status).toBe('ok');
    expect(await archon.stats()).toEqual(stats);
  });

  it('stats surfaces a SolverError from solvers that predate /stats', async () => {
    await expect(client().archon.stats()).rejects.toMatchObject({ status: 404 });
  });

  it('getPoolState reads the pool from chain', async () => {
    const pool = BASE_POOLS['USDC/DAI'].address;
    const chain = new FakeChain()
      .register(A.router, ArchonRouterAbi, { getPool: () => pool })
      .register(pool, StablePoolAbi, {
        token0: () => DAI,
        token1: () => USDC,
        getBalances: () => [4n * 10n ** 18n, 6_000_000n],
        feeBps: () => 4n,
        spotPrice: () => 10n ** 6n,
      });
    const state = await client(chain).archon.getPoolState('USDC/DAI');
    expect(state).toEqual({
      pair: 'DAI/USDC',
      pool,
      token0: DAI,
      token1: USDC,
      reserves: ['4000000000000000000', '6000000'],
      feeBps: 4,
      spotPrice: '1000000',
    });
  });

  it('getPoolState rejects malformed and unknown pairs', async () => {
    const chain = new FakeChain().register(A.router, ArchonRouterAbi, {
      getPool: () => '0x0000000000000000000000000000000000000000',
    });
    const { archon } = client(chain);
    await expect(archon.getPoolState('USDC')).rejects.toThrow(/look like/);
    await expect(archon.getPoolState('USDC/WETH')).rejects.toThrow(/No Archon pool/);
  });
});

describe('vault lookup', () => {
  it('getVault checks the factory registry and reads the operator', async () => {
    const chain = new FakeChain()
      .register(A.vaultFactory, VaultFactoryAbi, { isVault: (a: string) => a.toLowerCase() === VAULT.toLowerCase() })
      .register(VAULT, AgentVaultAbi, { operator: () => OPERATOR });
    const { archon } = client(chain);
    const vault = await archon.getVault(VAULT.toLowerCase());
    expect(vault.address).toBe(VAULT);
    expect(vault.operator).toBe(OPERATOR);
    await expect(archon.getVault('0x0000000000000000000000000000000000000001')).rejects.toThrow(/not an Archon vault/);
    await expect(archon.getVault('nope')).rejects.toBeInstanceOf(ArchonError);
  });

  it('useSessionKey refuses inactive keys', async () => {
    const chain = new FakeChain()
      .register(A.vaultFactory, VaultFactoryAbi, { isVault: () => true })
      .register(VAULT, AgentVaultAbi, {
        operator: () => OPERATOR,
        sessionKeys: () => [false, true, true, false, 0n, 0n, 0n, 0n, 0n],
      });
    const { Wallet } = await import('ethers');
    await expect(client(chain).archon.useSessionKey(VAULT, Wallet.createRandom())).rejects.toThrow(/not active/);
  });
});
