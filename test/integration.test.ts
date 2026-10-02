/**
 * Full flow against a Base mainnet fork (anvil). Skipped unless BASE_RPC_URL is set and anvil
 * is installed (ANVIL_PATH, ~/.foundry/bin, or PATH).
 *
 *   Part A — SDK vault management + SDK-signed intents settled by calling IntentEngine.settleBatch
 *            directly as an authorized solver. Proves the deployed contracts accept SDK signatures.
 *   Part B — the real archon-solver (../archon-solver) running against the fork: session.swap()
 *            → solver → settleBatch → waitForSettlement(), plus the WebSocket event stream.
 *            Skipped if the solver repo is not next to this one.
 *
 * Everything happens on the local fork; nothing is broadcast to Base.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Contract, Wallet, type JsonRpcProvider } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ArchonClient,
  ContractError,
  IntentEngineAbi,
  parseAmount,
  resolveTokenAddress,
  signIntent,
  type Intent,
  type IntentSettledEvent,
  type SessionKey,
  type Vault,
} from '../src/index.js';
import { dealErc20, findAnvil, impersonate, startAnvil, type Anvil } from './helpers/anvil.js';

const RPC = process.env.BASE_RPC_URL;
const ANVIL = findAnvil();
const SOLVER_DIR = resolve(__dirname, '../../archon-solver');
const SOLVER_TSX = resolve(SOLVER_DIR, 'node_modules/tsx/dist/cli.mjs');

const ADMIN = '0x867c6c5487Ea8504010B776a7a1475751F1b40a1';
const ENGINE = '0xf8614FED7664B2505EfD04581f1417D8317648D8';
const USDC = resolveTokenAddress('USDC');
const DAI = resolveTokenAddress('DAI');
// anvil's default funded accounts — public test keys, only meaningful on the local fork
const OPERATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SOLVER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const OTHER_OPERATOR_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

const SAFETY = {
  maxPerSwap: parseAmount('100', 'USDC'),
  maxPerWindow: parseAmount('500', 'USDC'),
  windowDuration: 3600,
  maxSlippageBps: 100,
  dailyCap: parseAmount('1000', 'USDC'),
  cooldownPeriod: 0,
  allowedTokens: ['USDC', 'DAI'],
};

describe.skipIf(!RPC || !ANVIL)('integration (Base fork)', () => {
  let anvil: Anvil;
  let provider: JsonRpcProvider;
  let operator: Wallet;
  let solverWallet: Wallet;

  beforeAll(async () => {
    anvil = await startAnvil(ANVIL!, RPC!, 8547);
    provider = anvil.provider;
    operator = new Wallet(OPERATOR_KEY, provider);
    solverWallet = new Wallet(SOLVER_KEY, provider);
    await dealErc20(provider, USDC, operator.address, 10_000n * 10n ** 6n);
    // Authorize our solver key on the deployed IntentEngine
    const admin = await impersonate(provider, ADMIN);
    const engine = new Contract(ENGINE, IntentEngineAbi, admin);
    await (await engine.getFunction('setSolver')(solverWallet.address, true)).wait();
  }, 120_000);

  afterAll(() => anvil?.stop());

  // ─── Part A ───────────────────────────────────────────────────────────────

  describe('vault lifecycle + contract acceptance', () => {
    let archon: ArchonClient;
    let vault: Vault;
    let session: SessionKey;

    beforeAll(() => {
      // No solver needed for Part A
      archon = new ArchonClient({ provider, solverUrl: 'http://127.0.0.1:9', chainId: 8453 });
    });

    it('creates a vault and refuses a second one', async () => {
      vault = await archon.createVault(operator);
      expect(vault.operator).toBe(operator.address);
      expect((await archon.getMyVault(operator))?.address).toBe(vault.address);
      await expect(archon.createVault(operator)).rejects.toThrow(/already has vault/);
    });

    it('initializes with safety parameters', async () => {
      await vault.initialize(SAFETY);
      expect(await vault.isInitialized()).toBe(true);
      const { allowedTokens: _allowed, ...onChain } = SAFETY;
      expect(await vault.getSafetyConfig()).toEqual(onChain);
      expect(await vault.isTokenAllowed('USDC')).toBe(true);
      expect(await vault.isTokenAllowed('WETH')).toBe(false);
      await expect(vault.initialize(SAFETY)).rejects.toThrow(/already initialized/);
    });

    it('validates safety config locally before spending gas', async () => {
      await expect(vault.updateSafetyConfig({ maxPerSwap: parseAmount('600', 'USDC') })).rejects.toThrow(
        /maxPerWindow must be >= maxPerSwap/,
      );
    });

    it('deposits (approving as needed), reports balances, withdraws', async () => {
      await vault.deposit('USDC', parseAmount('1000', 'USDC'));
      expect(await vault.getBalance('USDC')).toBe(parseAmount('1000', 'USDC'));
      const balances = await vault.getBalances();
      expect(balances.USDC).toBe(parseAmount('1000', 'USDC'));
      expect(balances.DAI).toBe('0');

      await vault.withdraw('USDC', parseAmount('100', 'USDC'));
      expect(await vault.getBalance('USDC')).toBe(parseAmount('900', 'USDC'));
    });

    it('decodes reverts into ContractError', async () => {
      const intruder = vault.connect(new Wallet(OTHER_OPERATOR_KEY, provider));
      await expect(intruder.freeze()).rejects.toThrow(/is not the operator/);
      // Bypass the SDK's own operator check to hit the contract's
      const raw = new Contract(
        vault.address,
        ['function emergencyFreeze()', 'error OnlyOperator()'],
        intruder['signer'],
      );
      const err = await raw
        .getFunction('emergencyFreeze')()
        .catch((e: unknown) => e);
      expect((err as { data?: string }).data).toBe(raw.interface.getError('OnlyOperator')!.selector);
      await expect(vault.withdraw('USDC', parseAmount('100000', 'USDC'))).rejects.toSatisfy(
        (e: unknown) => e instanceof ContractError && e.reason === 'InsufficientBalance',
      );
    });

    it('freezes and unfreezes', async () => {
      await vault.freeze();
      expect(await vault.isFrozen()).toBe(true);
      expect((await vault.getSpendingState()).frozen).toBe(true);
      await vault.unfreeze();
      expect(await vault.isFrozen()).toBe(false);
    });

    it('creates a session key with chain-time expiry', async () => {
      session = await vault.createSessionKey({ maxPerSwapOverride: parseAmount('50', 'USDC'), expiresIn: 3600 });
      expect(await session.isValid()).toBe(true);
      expect(session.permissions).toMatchObject({ canSwap: true, canBatchSwap: true, canCrossChainSwap: false });
      const block = await provider.getBlock('latest');
      expect(Math.abs(session.expiresAt() - (block!.timestamp + 3600))).toBeLessThanOrEqual(2);
      expect(await session.getNonce()).toBe(0);
      const keys = await vault.getSessionKeys();
      expect(keys.map((k) => k.address)).toContain(session.address);
      await expect(vault.createSessionKey({ maxPerSwapOverride: parseAmount('101', 'USDC') })).rejects.toThrow(
        /exceeds the vault's maxPerSwap/,
      );
    });

    it('the deployed IntentEngine settles an SDK-signed intent', async () => {
      // The live USDC/DAI pool holds only a few dollars, so keep trades small
      const amountIn = parseAmount('0.5', 'USDC');
      const block = await provider.getBlock('latest');
      const signed = await signIntent(
        session.signer,
        {
          vault: vault.address,
          tokenIn: USDC,
          tokenOut: DAI,
          amountIn,
          minAmountOut: parseAmount('0.45', 'DAI'),
          deadline: block!.timestamp + 300,
          nonce: await session.getNonce(),
        },
        8453,
      );

      const engine = new Contract(ENGINE, IntentEngineAbi, solverWallet);
      const [tokenA, tokenB] = USDC.toLowerCase() < DAI.toLowerCase() ? [USDC, DAI] : [DAI, USDC];
      const tx = await engine.getFunction('settleBatch')(tokenA, tokenB, [
        {
          vault: signed.vault,
          sessionKey: signed.sessionKey,
          tokenIn: signed.tokenIn,
          amountIn: signed.amountIn,
          minAmountOut: signed.minAmountOut,
          deadline: signed.deadline,
          nonce: signed.nonce,
          signature: signed.signature,
        },
      ]);
      const receipt = await tx.wait();
      const events = receipt.logs.map((l: never) => engine.interface.parseLog(l)?.name).filter(Boolean);
      expect(events).toContain('IntentFilled');
      expect(events).not.toContain('IntentSkipped');

      expect(BigInt(await vault.getBalance('DAI'))).toBeGreaterThanOrEqual(BigInt(signed.minAmountOut));
      expect(await vault.getKeyNonce(session.address)).toBe(1);
      expect((await vault.getSpendingState()).dailySpent).toBe(amountIn);
    });

    it('revokes the session key', async () => {
      await session.revoke();
      expect(await session.isValid()).toBe(false);
    });
  });

  // ─── Part B ───────────────────────────────────────────────────────────────

  describe.skipIf(!existsSync(SOLVER_TSX))('end to end with archon-solver', () => {
    const PORT = 3917;
    let solver: ChildProcess;
    let solverLog = '';
    let archon: ArchonClient;
    let vault: Vault;
    let session: SessionKey;

    beforeAll(async () => {
      solver = spawn(process.execPath, [SOLVER_TSX, 'src/index.ts'], {
        cwd: SOLVER_DIR,
        env: {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          SOLVER_PRIVATE_KEY: SOLVER_KEY,
          BASE_RPC_URL: anvil.url,
          PORT: String(PORT),
          DEPLOYMENT_FILE: resolve(SOLVER_DIR, 'deployments/8453.json'),
          MATCH_INTERVAL: '1000',
          EVENT_POLL_INTERVAL: '500',
          // Never let a test solver reach a real network
          BASE_WS_URL: '',
          PRIVATE_RPC_URL: '',
          FLASHBOTS_RPC: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      solver.stdout?.on('data', (d) => (solverLog += d));
      solver.stderr?.on('data', (d) => (solverLog += d));

      archon = new ArchonClient({
        provider,
        solverUrl: `http://127.0.0.1:${PORT}`,
        chainId: 8453,
        pollIntervalMs: 500,
      });
      const started = Date.now();
      for (;;) {
        try {
          await archon.health();
          break;
        } catch {
          if (solver.exitCode !== null || Date.now() - started > 60_000) {
            throw new Error(`solver did not start:\n${solverLog}`);
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      const operatorB = new Wallet(OTHER_OPERATOR_KEY, provider);
      await dealErc20(provider, USDC, operatorB.address, 10_000n * 10n ** 6n);
      vault = await archon.createVault(operatorB);
      await vault.initialize(SAFETY);
      await vault.deposit('USDC', parseAmount('500', 'USDC'));
      session = await vault.createSessionKey({ expiresIn: 3600 });
    }, 120_000);

    afterAll(() => {
      solver?.kill();
    });

    it('serves market data', async () => {
      const pairs = await archon.getPairs();
      expect(pairs.map((p) => p.name)).toContain('USDC/DAI');
      const quote = await archon.getQuote({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: parseAmount('1', 'USDC') });
      expect(BigInt(quote.expectedOut)).toBeGreaterThan(0n);
      const pool = await archon.getPoolState('USDC/DAI');
      expect(pool.reserves.every((r) => BigInt(r) > 0n)).toBe(true);
      expect((await archon.health()).chain).toBe(8453);
    });

    it('agent-side handle: useSessionKey with only the key and the vault address', async () => {
      const agent = await archon.useSessionKey(vault.address, session.signer);
      expect(agent.address).toBe(session.address);
      expect(agent.permissions.canBatchSwap).toBe(true);
    });

    it('swap → solver → on-chain settlement, with events', async () => {
      const stream = archon.subscribe({ vaults: [vault.address], events: ['intent.*', 'batch.settled'] });
      const settledEvents: IntentSettledEvent[] = [];
      stream.onIntentSettled((e) => settledEvents.push(e));
      await stream.ready();

      const before = BigInt(await vault.getBalance('DAI'));
      const intents: Intent[] = [];
      intents.push(
        await session.swap({
          tokenIn: 'USDC',
          tokenOut: 'DAI',
          amountIn: parseAmount('0.2', 'USDC'),
          slippageBps: 100,
        }),
      );
      // Second intent before the first settles: must get the next nonce, not reuse 0
      intents.push(
        await session.swap({
          tokenIn: 'USDC',
          tokenOut: 'DAI',
          amountIn: parseAmount('0.1', 'USDC'),
          slippageBps: 100,
        }),
      );
      expect(intents.map((i) => i.nonce)).toEqual([0, 1]);

      const results = await Promise.all(intents.map((i) => i.waitForSettlement(60_000)));
      for (const [k, result] of results.entries()) {
        expect(BigInt(result.amountOut)).toBeGreaterThanOrEqual(BigInt(intents[k]!.minAmountOut));
        expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(BigInt(result.matchedAmount) + BigInt(result.poolAmount)).toBe(BigInt(intents[k]!.amountIn));
      }
      const received = results.reduce((sum, r) => sum + BigInt(r.amountOut), 0n);
      expect(BigInt(await vault.getBalance('DAI')) - before).toBe(received);
      expect(await session.getNonce()).toBe(2);

      // The solver publishes intent.settled once it sees IntentFilled
      const deadline = Date.now() + 15_000;
      while (settledEvents.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      stream.close();
      expect(settledEvents.map((e) => e.intentId).sort()).toEqual(intents.map((i) => i.id).sort());
    }, 120_000);

    it('stats() reflects the settled swaps', async () => {
      // Intent statuses come from the solver's log listener; batch, gas and volume figures from the
      // submitter's own receipt poll, which can land a couple of seconds later
      let stats = await archon.stats();
      // The two intents may have gone out in one batch or two; wait until every batch is confirmed
      const pending = (s: typeof stats) =>
        s.settlement.batchesSubmitted === 0 || s.settlement.batchesSettled < s.settlement.batchesSubmitted;
      for (const until = Date.now() + 15_000; pending(stats) && Date.now() < until;) {
        await new Promise((r) => setTimeout(r, 250));
        stats = await archon.stats();
      }
      expect(stats.solver).toEqual({ address: solverWallet.address, chainId: 8453 });
      expect(stats.intents).toMatchObject({ received: 2, settled: 2, refunded: 0, expired: 0, failed: 0 });
      // Both intents sold USDC: nothing to match against, so everything went through the pool
      expect(stats.intents).toMatchObject({ matched: 0, routedThroughPool: 2 });
      expect(stats.volume.byPair['USDC/DAI']).toEqual({
        quoteToken: 'USDC',
        settled: parseAmount('0.3', 'USDC'),
        matched: '0',
        routedThroughPool: parseAmount('0.3', 'USDC'),
        matchRate: 0,
      });
      expect(stats.mempool).toMatchObject({ pending: 0, inFlight: 0 });
      expect(stats.settlement.batchesSettled).toBeGreaterThanOrEqual(1);
      expect(stats.settlement.batchesSubmitted).toBe(stats.settlement.batchesSettled);
      expect(BigInt(stats.settlement.gasSpentWei)).toBeGreaterThan(0n);
      expect(stats.settlement.averageSettlementMs).toBeGreaterThan(0);
    });

    it('surfaces solver validation errors', async () => {
      await expect(
        session.swap({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: parseAmount('1000', 'USDC'), minAmountOut: '1' }),
      ).rejects.toThrow(/vault balance .* is below amountIn/);
    });
  });
});
