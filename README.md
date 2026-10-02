# @plagtech/archon-sdk

TypeScript SDK for trading on the **Archon DEX** — the agent-native decentralized exchange on Base.

Give a trading agent a vault with protocol-enforced spending caps, a short-lived session key, and a
one-line `swap()`. The SDK handles vault setup, deposits, session keys, intent signing, solver
submission, settlement tracking and real-time events.

- **Agents first** — fully programmatic: no wallet popups, no browser. Runs in Node.js 18+.
- **Safe defaults** — session keys expire in 1 hour, spending caps are required, token allowlists are explicit.
- **Exact amounts** — every amount is a base-units string (`"1000000"` = 1 USDC). No floats, ever.
- **Light** — depends only on ethers v6 (and `ws`, which ethers already pulls in). ESM + CommonJS + type declarations.

```bash
npm install @plagtech/archon-sdk ethers
```

## Quick start

```typescript
import { Wallet } from 'ethers';
import { ArchonClient, parseAmount, formatAmount } from '@plagtech/archon-sdk';

const archon = new ArchonClient({
  rpcUrl: 'https://base-mainnet.g.alchemy.com/v2/YOUR_KEY',
  solverUrl: 'https://solver.archon.exchange',
  chainId: 8453,
});
const operator = new Wallet(process.env.OPERATOR_KEY!, archon.provider);

// 1. Create a vault (once per operator)
const vault = await archon.createVault(operator);

// 2. Initialize it with safety parameters (once)
await vault.initialize({
  maxPerSwap: parseAmount('10000', 'USDC'), // 10,000 USDC
  maxPerWindow: parseAmount('50000', 'USDC'), // per rolling window
  windowDuration: 3600, // 1 hour window
  maxSlippageBps: 50, // 0.5%
  dailyCap: parseAmount('100000', 'USDC'),
  cooldownPeriod: 300, // 5 min before an unfreeze is allowed
  allowedTokens: ['USDC', 'DAI'], // symbols or addresses
});

// 3. Deposit (approves the vault for exactly this amount if needed)
await vault.deposit('USDC', parseAmount('1000', 'USDC'));

// 4. Create a session key for your agent
const session = await vault.createSessionKey({
  canSwap: true,
  canBatchSwap: true, // required for solver-settled swaps
  canCrossChainSwap: false,
  maxPerSwapOverride: parseAmount('5000', 'USDC'),
  expiresIn: 3600, // 1 hour (the default)
});

// 5. The agent trades
const intent = await session.swap({
  tokenIn: 'USDC',
  tokenOut: 'DAI',
  amountIn: parseAmount('1', 'USDC'),
  slippageBps: 30, // minAmountOut = quote × (1 − 0.3%)
});
console.log(intent.id, intent.status); // '0x…', 'pending'

// 6. Wait for on-chain settlement
const result = await intent.waitForSettlement();
console.log(formatAmount(result.amountOut, 'DAI'), result.txHash);

// 7. Real-time events
const stream = archon.subscribe({ vaults: [vault.address], events: ['intent.*', 'batch.settled'] });
stream.onIntentSettled((e) => console.log(`settled: ${e.amountOut} of ${e.tokenOut}`));

// Cleanup
await session.revoke();
stream.close();
```

More in [`examples/`](examples): a minimal swap, a long-running agent loop, and an event monitor.

## How it works

```
operator ──createVault/initialize/deposit──▶ AgentVault ◀── caps, allowlist, circuit breaker
operator ──createSessionKey─────────────────▶ (scoped key, expires)

agent ──session.swap()──▶ signs intent ──POST /intent──▶ solver ──settleBatch──▶ IntentEngine
                                                                       │
                          vault.executeBatchLeg (verifies signature, nonce, caps) ◀┘
                          opposing intents are matched peer-to-peer; only the excess hits the pool
```

- **Vault** — holds the operator's funds. Every agent action is checked on-chain against per-swap,
  per-window and daily caps and the token allowlist. A cap breach freezes the vault.
- **Session key** — a separate key the agent signs with. It cannot withdraw, is limited to the
  permissions and per-swap cap you set, and expires.
- **Intent** — a signed "sell X of A for at least Y of B before T". The solver batches intents per
  pair and settles them in one transaction at a single clearing price. You are protected by your
  signed `minAmountOut`; an intent that can't meet it is refunded.

## Agent-side usage

In production the operator and the agent are usually separate processes. The agent needs only the
session key and the vault address — never the operator's key:

```typescript
// Operator: generate and register, then hand over the private key
const session = await vault.createSessionKey({ expiresIn: 3600 });
sendToAgent({ vault: vault.address, key: (session.signer as Wallet).privateKey });

// …or let the agent generate its own key and register only the address
await vault.registerSessionKey(agentAddress, { expiresIn: 3600 });

// Agent
const archon = new ArchonClient({ rpcUrl, solverUrl });
const session = await archon.useSessionKey(vaultAddress, new Wallet(agentKey));
const intent = await session.swap({ tokenIn: 'USDC', tokenOut: 'USDT', amountIn: '1000000' });
```

The SDK never stores keys. Signers are passed in and used for the duration of the call.

## API

### `ArchonClient`

| Method                            | Description                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `new ArchonClient(config)`        | `{ rpcUrl \| provider, solverUrl, chainId?, contracts?, fetch?, WebSocket? }` |
| `createVault(signer)`             | Deploy the signer's vault (one per operator)                                  |
| `getVault(address, signer?)`      | Load a vault; pass the operator signer for write access                       |
| `getMyVault(signer)`              | The signer's vault, or `null`                                                 |
| `useSessionKey(vault, signer)`    | Agent-side `SessionKey` handle                                                |
| `getPairs()` / `getQuote(params)` | Market data from the solver                                                   |
| `getPoolState('USDC/DAI')`        | Reserves, fee and spot price read from chain                                  |
| `subscribe(filter?)`              | `EventStream` over WebSocket                                                  |
| `health()` / `stats()`            | Solver status (`/stats` is not served by the solver yet)                      |

### `Vault`

| Method                                                                   | Description                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------- |
| `initialize(config)`                                                     | One-time safety setup; validated locally before sending |
| `deposit(token, amount)` / `withdraw(token, amount, to?)`                | `'ETH'` = native ether                                  |
| `getBalance(token)` / `getBalances()`                                    | Base units; `getBalances` covers every built-in token   |
| `updateSafetyConfig(changes)` / `getSafetyConfig()`                      | Partial updates merge with current values               |
| `setTokenAllowed(token, bool)` / `isTokenAllowed(token)`                 |                                                         |
| `freeze()` / `unfreeze()` / `isFrozen()` / `getSpendingState()`          | `unfreeze` reports the remaining cooldown               |
| `createSessionKey(config?, key?)` / `registerSessionKey(address, cfg?)`  | Optional per-key token scope via `allowedTokens`        |
| `revokeSessionKey(address)` / `getSessionKeys()` / `isKeyValid(address)` |                                                         |
| `connect(signer)`                                                        | Same vault with a different signer                      |

### `SessionKey`

| Member                                      | Description                                                     |
| ------------------------------------------- | --------------------------------------------------------------- |
| `swap(params)`                              | Sign and submit; returns an `Intent` once the solver accepts it |
| `getQuote(params)` / `getNonce()`           |                                                                 |
| `revoke()` / `isValid()`                    | `revoke` needs the operator's vault                             |
| `expiresAt()` / `timeUntilExpiry()`         | Unix seconds / seconds remaining                                |
| `address`, `vault`, `permissions`, `signer` |                                                                 |

`swap` options: `tokenIn`, `tokenOut`, `amountIn`, and either `slippageBps` (default 50, applied to a
fresh quote) or an explicit `minAmountOut`; `deadline` defaults to now + 5 minutes. Nonces are
managed for you, including several intents in flight at once.

### `Intent`

| Member                            | Description                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `getStatus()` / `getStatusInfo()` | `pending → matched → settling → settled`, or `refunded` / `expired` / `failed` |
| `waitForSettlement(timeoutMs?)`   | Resolves with `SettlementResult`; throws `IntentFailedError` or `TimeoutError` |
| `on(status, cb)` / `off(...)`     | Polls while listened to                                                        |

`SettlementResult`: `amountOut`, `txHash`, `blockNumber`, `batchId`, `matched`, `matchedAmount`
(filled peer-to-peer), `poolAmount` (routed through the pool), `gasCost` (whole batch, paid by the solver).

### `EventStream`

```typescript
stream.on('intent.settled', (data, envelope) => …); // exact name
stream.on('intent.*', …);                           // prefix
stream.on('*', …);                                  // everything
stream.on('open' | 'close' | 'subscribed' | 'error', …);
await stream.ready();                               // subscription acknowledged
```

Helpers: `onIntentSettled`, `onBatchSettled`, `onCircuitBreaker`, `onPriceChange`. The stream
reconnects with backoff and re-subscribes until `close()`. Events: `intent.accepted|matched|settling|settled|refunded|expired|failed`,
`batch.settled`, `pool.price`, `vault.swapExecuted|swapBlocked|circuitBreaker|frozen|unfrozen`.

### Amounts and tokens

```typescript
parseAmount('100.5', 'USDC'); // '100500000'   (throws rather than rounding)
formatAmount('100500000', 'USDC'); // '100.5'
parseAmount('2.5', 8); // decimals for tokens outside the registry
```

Built-in tokens on Base: `USDC`, `USDT`, `DAI`, `WETH`, and `ETH` (native ether, for vault
deposits/withdrawals only — trade WETH). Raw addresses work everywhere.

### Errors

| Class               | When                                                                         |
| ------------------- | ---------------------------------------------------------------------------- |
| `ArchonError`       | Base class; also invalid input caught locally before any transaction         |
| `ContractError`     | A contract reverted; `reason` is the decoded custom error (`'OnlyOperator'`) |
| `SolverError`       | Solver returned non-2xx (`status`) or was unreachable (`status === 0`)       |
| `IntentFailedError` | Intent ended `refunded`, `expired` or `failed` (`status`, `info.reason`)     |
| `TimeoutError`      | `waitForSettlement` gave up                                                  |

## Contracts (Base mainnet, chain 8453)

| Contract         | Address                                      |
| ---------------- | -------------------------------------------- |
| ArchonRouter     | `0x45B3042c8a4C2D540a15E89C13B65392d2e14289` |
| VaultFactory     | `0x58C92a2e7e3b5c3897Ab03466e7f5c1030A40F29` |
| IntentEngine     | `0xf8614FED7664B2505EfD04581f1417D8317648D8` |
| SpraayAdapter    | `0xcF0bE3C00c2D4931315ED524161Dd124626044c2` |
| CrossChainEscrow | `0xb1eD61a562686B618B4B2856839e65F9B2662321` |

Override any of them with `new ArchonClient({ contracts: { … } })`. ABIs are exported
(`AgentVaultAbi`, `IntentEngineAbi`, …).

## Intent signing

Solver-settled intents use the batch format verified by `AgentVault.executeBatchLeg`:

```
intentHash  = keccak256(abi.encodePacked(BATCH_INTENT_TAG, tokenIn, tokenOut, amountIn, minAmountOut, deadline))
messageHash = keccak256(abi.encodePacked(intentHash, nonce, vault, chainId))
signature   = EIP-191 personal_sign over the 32 bytes of messageHash
BATCH_INTENT_TAG = keccak256("ARCHON_BATCH_INTENT")
```

`signIntent`, `verifyIntent` and `batchSigningDigest` are exported for custom signers (KMS, HSM);
signatures with `v ∈ {0,1}` or high `s` are normalized automatically.

## Development

```bash
npm install
npm test            # unit tests (mocked chain + solver)
npm run typecheck
npm run lint
npm run build       # dist/: ESM, CJS, .d.ts
npm run copy-abis   # refresh ABIs from ../archon-solver and ../archon
```

Fork tests run when `BASE_RPC_URL` is set and [anvil](https://book.getfoundry.sh) is installed:

```bash
BASE_RPC_URL=https://mainnet.base.org npm test
```

They verify signatures against the deployed vault (`eth_call`), run the full vault lifecycle on a
Base fork, and — if `../archon-solver` is present — run the real solver against the fork for an
end-to-end `swap → settle` with events. Nothing is broadcast to mainnet.

## License

MIT © Plagtech LLC
