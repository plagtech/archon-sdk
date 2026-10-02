/**
 * Minimal end-to-end flow: create (or reuse) a vault, configure it, deposit USDC, mint a session
 * key, swap USDC → DAI through the solver, and wait for on-chain settlement.
 *
 *   OPERATOR_KEY=0x… RPC_URL=https://… SOLVER_URL=https://solver.archon.exchange npx tsx examples/basic-swap.ts
 *
 * Uses real funds on Base mainnet. Start small.
 */
import { Wallet } from 'ethers';
import { ArchonClient, IntentFailedError, formatAmount, parseAmount } from '@plagtech/archon-sdk';

const { OPERATOR_KEY, RPC_URL, SOLVER_URL = 'https://solver.archon.exchange' } = process.env;
if (!OPERATOR_KEY || !RPC_URL) throw new Error('Set OPERATOR_KEY and RPC_URL');

const archon = new ArchonClient({ rpcUrl: RPC_URL, solverUrl: SOLVER_URL, chainId: 8453 });
const operator = new Wallet(OPERATOR_KEY, archon.provider);

// 1. One vault per operator: reuse it if it exists
const vault = (await archon.getMyVault(operator)) ?? (await archon.createVault(operator));
console.log('vault', vault.address);

// 2. Safety parameters (once)
if (!(await vault.isInitialized())) {
  await vault.initialize({
    maxPerSwap: parseAmount('100', 'USDC'),
    maxPerWindow: parseAmount('500', 'USDC'),
    windowDuration: 3600,
    maxSlippageBps: 50,
    dailyCap: parseAmount('1000', 'USDC'),
    cooldownPeriod: 300,
    allowedTokens: ['USDC', 'DAI'],
  });
}

// 3. Fund it
await vault.deposit('USDC', parseAmount('5', 'USDC'));
console.log('balances', await vault.getBalances());

// 4. A session key for the agent: batch swaps only, 1 USDC per swap, 1 hour
const session = await vault.createSessionKey({
  canSwap: false,
  canBatchSwap: true,
  maxPerSwapOverride: parseAmount('1', 'USDC'),
  expiresIn: 3600,
});
console.log('session key', session.address, 'expires', new Date(session.expiresAt() * 1000).toISOString());

// 5. Trade
const quote = await session.getQuote({ tokenIn: 'USDC', tokenOut: 'DAI', amountIn: parseAmount('1', 'USDC') });
console.log(`quote: 1 USDC → ${formatAmount(quote.expectedOut, 'DAI')} DAI (impact ${quote.priceImpactBps} bps)`);

const intent = await session.swap({
  tokenIn: 'USDC',
  tokenOut: 'DAI',
  amountIn: parseAmount('1', 'USDC'),
  slippageBps: 30,
});
console.log('intent', intent.id, intent.status);

// 6. Settlement
try {
  const result = await intent.waitForSettlement();
  console.log(`settled: ${formatAmount(result.amountOut, 'DAI')} DAI in ${result.txHash}`);
  console.log(`matched peer-to-peer: ${result.matchedAmount}, via pool: ${result.poolAmount}`);
} catch (err) {
  if (err instanceof IntentFailedError)
    console.error(`not filled (${err.status}): ${err.info.reason ?? 'no reason given'}`);
  else throw err;
}

// Cleanup: the key would expire on its own, but revoking is immediate
await session.revoke();
