/**
 * Watch the solver's real-time event stream. No wallet needed.
 *
 *   SOLVER_URL=https://solver.archon.exchange VAULT=0x… npx tsx examples/event-stream.ts
 *
 * VAULT is optional: without it you see intent events for every vault.
 */
import { ArchonClient, formatAmount, findToken } from '@plagtech/archon-sdk';

const { SOLVER_URL = 'https://solver.archon.exchange', RPC_URL = 'https://mainnet.base.org', VAULT } = process.env;

const archon = new ArchonClient({ rpcUrl: RPC_URL, solverUrl: SOLVER_URL });
const stream = archon.subscribe({
  vaults: VAULT ? [VAULT] : undefined,
  events: ['intent.*', 'batch.settled', 'pool.price', 'vault.*'],
});

/** "1.5 USDC" for registry tokens, raw base units otherwise */
const human = (amount: string, token: string) => {
  const info = findToken(token);
  return info ? `${formatAmount(amount, info.decimals)} ${info.symbol}` : `${amount} of ${token}`;
};

stream.on('open', () => console.log('connected'));
stream.on('close', ({ code }) => console.log(`disconnected (${code}); reconnecting…`));
stream.on('error', (err) => console.warn('error:', err instanceof Error ? err.message : err));

stream.on('intent.accepted', (e) =>
  console.log(`accepted  ${e.intentId.slice(0, 10)} ${human(e.amountIn, e.tokenIn)}`),
);
stream.onIntentSettled((e) =>
  console.log(`settled   ${e.intentId.slice(0, 10)} → ${human(e.amountOut, e.tokenOut)} (${e.txHash})`),
);
stream.on('intent.refunded', (e) => console.log(`refunded  ${e.intentId.slice(0, 10)}: ${e.reason ?? ''}`));
stream.on('intent.expired', (e) => console.log(`expired   ${e.intentId.slice(0, 10)}`));
stream.onBatchSettled((e) => console.log(`batch #${e.batchId} ${e.pair}: ${e.count} filled, volume`, e.volume));
stream.onPriceChange((e) => console.log(`price     ${e.pair} ${e.price} (${e.changeBps ?? '—'} bps)`));
stream.onCircuitBreaker((e) => console.log(`BREAKER   vault ${e.vault}: ${e.reason}`));

await stream.ready();
console.log('subscribed; Ctrl+C to exit');
process.on('SIGINT', () => {
  stream.close();
  process.exit(0);
});
