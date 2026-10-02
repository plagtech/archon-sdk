/**
 * An agent loop. The agent holds only a session key and the vault address — never the
 * operator's key. It keeps the vault's USDC/USDT split near 50/50, trading at most once per
 * cycle, and stops when its key is about to expire or the vault's circuit breaker trips.
 *
 *   SESSION_KEY=0x… VAULT=0x… RPC_URL=https://… SOLVER_URL=https://solver.archon.exchange npx tsx examples/agent-trading.ts
 *
 * The operator creates the key with vault.createSessionKey() (or registers an agent-generated
 * address with vault.registerSessionKey()) and hands over SESSION_KEY and VAULT.
 */
import { Wallet } from 'ethers';
import { ArchonClient, ArchonError, IntentFailedError, formatAmount } from '@plagtech/archon-sdk';

const { SESSION_KEY, VAULT, RPC_URL, SOLVER_URL = 'https://solver.archon.exchange' } = process.env;
if (!SESSION_KEY || !VAULT || !RPC_URL) throw new Error('Set SESSION_KEY, VAULT and RPC_URL');

const CYCLE_MS = 30_000;
/** Rebalance when one side exceeds the other by more than this (base units, 6 decimals) */
const THRESHOLD = 2_000_000n; // 2 USDC
const MAX_TRADE = 1_000_000n; // 1 USDC per swap

const archon = new ArchonClient({ rpcUrl: RPC_URL, solverUrl: SOLVER_URL });
const session = await archon.useSessionKey(VAULT, new Wallet(SESSION_KEY));
const vault = session.vault; // read-only: no operator signer here
console.log(`agent ${session.address} on vault ${vault.address}, key valid for ${session.timeUntilExpiry()}s`);

let running = true;
const stop = (why: string) => {
  if (!running) return;
  running = false;
  console.log(`stopping: ${why}`);
};
process.on('SIGINT', () => stop('SIGINT'));

// The circuit breaker freezes the vault; nothing will fill until the operator unfreezes it
const stream = archon.subscribe({
  vaults: [vault.address],
  events: ['vault.circuitBreaker', 'vault.frozen', 'intent.*'],
});
stream.onCircuitBreaker((e) => stop(`circuit breaker: ${e.reason}`));
stream.on('vault.frozen', () => stop('vault frozen by operator'));
stream.on('error', (err) => console.warn('stream error', err));

while (running) {
  if (session.timeUntilExpiry() < 120) {
    stop('session key expires soon');
    break;
  }
  try {
    await tick();
  } catch (err) {
    // Solver/RPC hiccups are expected in a long-running loop; log and try next cycle
    console.warn('cycle failed:', err instanceof ArchonError ? err.message : err);
  }
  await new Promise((r) => setTimeout(r, CYCLE_MS));
}
stream.close();

async function tick() {
  if (await vault.isFrozen()) return stop('vault is frozen');

  const usdc = BigInt(await vault.getBalance('USDC'));
  const usdt = BigInt(await vault.getBalance('USDT'));
  const diff = usdc - usdt;
  if (diff > -THRESHOLD && diff < THRESHOLD) return;

  const [tokenIn, tokenOut] = diff > 0n ? (['USDC', 'USDT'] as const) : (['USDT', 'USDC'] as const);
  const half = (diff > 0n ? diff : -diff) / 2n;
  const amountIn = (half < MAX_TRADE ? half : MAX_TRADE).toString();

  const quote = await session.getQuote({ tokenIn, tokenOut, amountIn });
  if (quote.priceImpactBps > 20) {
    console.log(`skip: ${quote.priceImpactBps} bps impact for ${formatAmount(amountIn, tokenIn)} ${tokenIn}`);
    return;
  }

  const intent = await session.swap({ tokenIn, tokenOut, amountIn, slippageBps: 25 });
  console.log(`swap ${formatAmount(amountIn, tokenIn)} ${tokenIn} → ${tokenOut} (nonce ${intent.nonce})`);
  try {
    const result = await intent.waitForSettlement();
    console.log(`  filled ${formatAmount(result.amountOut, tokenOut)} ${tokenOut} (${result.txHash})`);
  } catch (err) {
    if (!(err instanceof IntentFailedError)) throw err;
    // Refunded/expired intents cost nothing but time; the next cycle re-evaluates
    console.log(`  ${err.status}: ${err.info.reason ?? 'no reason given'}`);
  }
}
