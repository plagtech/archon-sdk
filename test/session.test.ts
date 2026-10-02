import { Wallet, getAddress } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentVaultAbi } from '../src/contracts/index.js';
import { nowSec } from '../src/context.js';
import { SessionKey, nextFreeNonce } from '../src/session.js';
import { verifyIntent } from '../src/signing/intent.js';
import { resolveTokenAddress } from '../src/tokens/registry.js';
import type { IntentStatus, SessionKeyInfo, SignedIntent } from '../src/types.js';
import { Vault } from '../src/vault.js';
import { FakeChain, fakeContext, fakeFetch, type FakeRoute } from './helpers/fakes.js';

const VAULT = getAddress('0x00000000000000000000000000000000000000aa');
const USDC = resolveTokenAddress('USDC');
const DAI = resolveTokenAddress('DAI');

describe('nextFreeNonce', () => {
  it.each([
    [0, [], 0],
    [3, [], 3],
    [0, [0, 1], 2],
    [0, [1, 2], 0], // nonce 0's intent died: reuse it so 1 and 2 can proceed
    [5, [5, 7], 6],
    [5, [1, 2], 5], // stale entries below the on-chain nonce are irrelevant
  ])('on-chain %i, held %j → %i', (onChain, held, expected) => {
    expect(nextFreeNonce(onChain, held)).toBe(expected);
  });
});

/**
 * A solver double: accepts intents, tracks their status, and can be told to answer 409.
 * The on-chain nonce comes from the fake vault.
 */
function setup(overrides: Partial<SessionKeyInfo> = {}) {
  const key = Wallet.createRandom();
  const state = { onChainNonce: 0, conflicts: new Set<number>(), statuses: new Map<string, IntentStatus>() };
  const submitted: SignedIntent[] = [];
  const routes: FakeRoute[] = [
    { path: '/quote', body: { expectedOut: '1000000', priceImpactBps: 0, poolFee: '0', spotPrice: '1' } },
    {
      method: 'POST',
      path: '/intent',
      status: 202,
      body: ({ body }: { body: unknown }) => {
        const intent = body as SignedIntent;
        submitted.push(intent);
        const id = `0x${submitted.length}`;
        state.statuses.set(id, 'pending');
        return { intentId: id, status: 'pending', estimatedSettlement: 0 };
      },
    },
    {
      path: '/status/',
      body: ({ url }: { url: string }) => ({
        intentId: url.split('/').pop(),
        status: state.statuses.get(url.split('/').pop()!),
      }),
    },
  ];
  // 409 for nonces another process holds
  const base = fakeFetch(routes);
  const fetch: typeof base.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as SignedIntent;
      if (state.conflicts.has(body.nonce)) {
        return new Response(JSON.stringify({ error: 'another live intent already uses this session key nonce' }), {
          status: 409,
        });
      }
    }
    return base.fetch(url, init);
  };

  const chain = new FakeChain().register(VAULT, AgentVaultAbi, { getKeyNonce: () => BigInt(state.onChainNonce) });
  const ctx = fakeContext(chain, fetch);
  const vault = new Vault(ctx, VAULT, Wallet.createRandom().address);
  const info: SessionKeyInfo = {
    address: key.address,
    active: true,
    canSwap: true,
    canBatchSwap: true,
    canCrossChainSwap: false,
    maxPerSwapOverride: '0',
    expiry: nowSec() + 3600,
    nonce: 0,
    totalSpent: '0',
    registeredAt: nowSec(),
    ...overrides,
  };
  const session = new SessionKey(ctx, vault, key, info);
  return { session, state, submitted, requests: base.requests };
}

describe('SessionKey.swap', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));

  it('signs a verifiable batch intent and derives minAmountOut from the quote', async () => {
    const intent = await t.session.swap({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: '1000000', slippageBps: 30 });
    const sent = t.submitted[0]!;
    expect(sent).toMatchObject({ vault: VAULT, tokenIn: USDC, tokenOut: DAI, amountIn: '1000000', nonce: 0 });
    expect(sent.minAmountOut).toBe('997000'); // 1_000_000 × (1 − 0.003)
    expect(verifyIntent(sent, 8453)).toBe(true);
    expect(intent.id).toBe('0x1');
    expect(intent.status).toBe('pending');
    expect(intent.deadline).toBeGreaterThan(nowSec() + 290);
  });

  it('uses an explicit minAmountOut without quoting', async () => {
    await t.session.swap({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: '5', minAmountOut: '4' });
    expect(t.submitted[0]!.minAmountOut).toBe('4');
    expect(t.requests.some((r) => r.url.includes('/quote'))).toBe(false);
  });

  it('assigns consecutive nonces to concurrent intents', async () => {
    const a = await t.session.swap({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: '1', minAmountOut: '1' });
    const b = await t.session.swap({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: '1', minAmountOut: '1' });
    expect([a.nonce, b.nonce]).toEqual([0, 1]);
    expect(await t.session.getNonce()).toBe(2);
  });

  it('frees the nonce of an intent that expired without being pulled', async () => {
    await t.session.swap({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: '1', minAmountOut: '1' }); // nonce 0
    await t.session.swap({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: '1', minAmountOut: '1' }); // nonce 1
    t.state.statuses.set('0x1', 'expired');
    expect(await t.session.getNonce()).toBe(0);
  });

  it('keeps settled nonces taken even if the RPC has not caught up', async () => {
    await t.session.swap({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: '1', minAmountOut: '1' });
    t.state.statuses.set('0x1', 'settled');
    expect(await t.session.getNonce()).toBe(1);
    t.state.onChainNonce = 1;
    expect(await t.session.getNonce()).toBe(1);
  });

  it('skips nonces another process holds (409) and retries', async () => {
    t.state.conflicts = new Set([0, 1]);
    const intent = await t.session.swap({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: '1', minAmountOut: '1' });
    expect(intent.nonce).toBe(2);
  });

  it('gives up after repeated nonce conflicts', async () => {
    t.state.conflicts = new Set([0, 1, 2, 3, 4, 5]);
    await expect(
      t.session.swap({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: '1', minAmountOut: '1' }),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it.each([
    [{ tokenOut: 'USDC' }, /must differ/],
    [{ amountIn: '0' }, /positive/],
    [{ tokenIn: 'ETH' }, /use WETH/],
    [{ deadline: 1 }, /deadline must be in the future/],
    [{ slippageBps: 10_000 }, /slippageBps/],
    [{ slippageBps: 1.5 }, /slippageBps/],
  ])('rejects %o before signing', async (patch, error) => {
    await expect(t.session.swap({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: '1', ...patch })).rejects.toThrow(error);
    expect(t.submitted).toHaveLength(0);
  });

  it('enforces permissions, expiry and the per-key cap locally', async () => {
    const swap = { tokenIn: 'USDC', tokenOut: 'DAI', amountIn: '200', minAmountOut: '1' };
    await expect(setup({ canBatchSwap: false }).session.swap(swap)).rejects.toThrow(/canBatchSwap/);
    await expect(setup({ expiry: nowSec() - 1 }).session.swap(swap)).rejects.toThrow(/expired/);
    await expect(setup({ maxPerSwapOverride: '100' }).session.swap(swap)).rejects.toThrow(/maxPerSwapOverride/);
  });

  it('refuses a quote with zero output', async () => {
    const s = setup();
    const ctxQuote = s.session as unknown as { ctx: { solver: { quote: () => Promise<unknown> } } };
    ctxQuote.ctx.solver.quote = async () => ({ expectedOut: '0', priceImpactBps: 0, poolFee: '0', spotPrice: '0' });
    await expect(s.session.swap({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: '1' })).rejects.toThrow(/zero output/);
  });

  it('reports expiry', () => {
    const s = setup({ expiry: nowSec() + 100 }).session;
    expect(s.expiresAt()).toBe(nowSec() + 100);
    expect(s.timeUntilExpiry()).toBeGreaterThan(98);
  });
});
