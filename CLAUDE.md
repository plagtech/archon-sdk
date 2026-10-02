# Archon SDK — TypeScript SDK for Agent Trading

## What This Is

The Archon SDK is the npm package that agent developers install to trade on the Archon DEX.
It handles vault creation, token deposits, session key management, intent signing, solver
submission, and event streaming — all in a few lines of TypeScript.

This is the distribution layer. When a developer building a trading agent asks "how do I
let my agent swap tokens safely on-chain," they install this package and have it working
in 15 minutes.

**Package:** @plagtech/archon-sdk
**Repo:** plagtech/archon-sdk
**Language:** TypeScript
**Target:** Node.js 18+ and modern browsers (ESM + CJS dual build)
**Publish to:** npm

## Design Principles

1. **Agents first.** Every API call should be callable programmatically without human
   interaction. No popups, no wallet connect, no browser requirements.
2. **Safe defaults.** Session keys expire in 1 hour by default. Spending caps are
   required at initialization. Token allowlists are explicit.
3. **Minimal dependencies.** ethers.js v6 for chain interaction, nothing else heavy.
   The SDK should not pull in React, web3modal, or any browser framework.
4. **Type-safe.** Full TypeScript with strict mode. Every contract return value and
   event is typed. Agents get compile-time safety.

## Deployed Infrastructure

### Contracts (Base mainnet, chain 8453)

- **ArchonRouter:** 0x45B3042c8a4C2D540a15E89C13B65392d2e14289
- **VaultFactory:** 0x58C92a2e7e3b5c3897Ab03466e7f5c1030A40F29
- **IntentEngine:** 0xf8614FED7664B2505EfD04581f1417D8317648D8
- **SpraayAdapter:** 0xcF0bE3C00c2D4931315ED524161Dd124626044c2
- **CrossChainEscrow:** 0xb1eD61a562686B618B4B2856839e65F9B2662321
- **StablePool USDC/USDT:** 0x9c77673FBC4aa696a81FFeEead58973E18A1C242
- **StablePool USDC/DAI:** 0x98B17F4615a5c32C7e3B0b91ba46445f3b582B40
- **VolatilePool USDC/WETH:** 0xEed7535E76Ac2ddF8bb649007d28A30b8f3B2CD8

### Solver

- **API:** The solver URL is configurable. Default: https://solver.archon.exchange
  (or the Railway URL until the custom domain is set up)
- **Endpoints the SDK calls:**
  - `POST /intent` — submit a signed swap intent
  - `GET /quote` — get a price quote for a pair
  - `GET /pairs` — list supported trading pairs
  - `GET /status/:intentId` — check intent status
  - `WS /ws` — real-time event stream

### Tokens (Base)

- USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (6 decimals)
- USDT: 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2 (6 decimals)
- DAI: 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb (18 decimals)
- WETH: 0x4200000000000000000000000000000000000006 (18 decimals)

## User-Facing API

The SDK should expose a clean, high-level API. Here's what the developer experience
should look like:

### Quick Start (README example)

```typescript
import { ArchonClient } from '@plagtech/archon-sdk';

// Connect to Archon on Base
const archon = new ArchonClient({
  rpcUrl: 'https://base-mainnet.g.alchemy.com/v2/YOUR_KEY',
  solverUrl: 'https://solver.archon.exchange',
  chainId: 8453,
});

// Step 1: Create a vault (operator does this once)
const vault = await archon.createVault(operatorWallet);

// Step 2: Initialize with safety parameters
await vault.initialize({
  maxPerSwap: '10000000000',       // 10,000 USDC (6 decimals)
  maxPerWindow: '50000000000',     // 50,000 USDC per hour
  windowDuration: 3600,            // 1 hour window
  maxSlippageBps: 50,              // 0.5% max slippage
  dailyCap: '100000000000',        // 100,000 USDC daily
  cooldownPeriod: 300,             // 5 min freeze cooldown
  allowedTokens: ['USDC', 'DAI'],  // or pass addresses directly
});

// Step 3: Deposit tokens
await vault.deposit('USDC', '1000000000'); // 1,000 USDC

// Step 4: Create a session key for your agent
const session = await vault.createSessionKey({
  canSwap: true,
  canBatchSwap: true,
  canCrossChainSwap: false,
  maxPerSwapOverride: '5000000000', // 5,000 USDC per swap
  expiresIn: 3600,                  // 1 hour
});

// Step 5: Agent uses the session key to trade
const intent = await session.swap({
  tokenIn: 'USDC',
  tokenOut: 'DAI',
  amountIn: '1000000',    // 1 USDC
  slippageBps: 30,        // 0.3% slippage tolerance
});

console.log(intent.id);      // intent ID
console.log(intent.status);  // 'pending' | 'matched' | 'settled' | ...

// Step 6: Wait for settlement
const result = await intent.waitForSettlement();
console.log(result.amountOut);  // actual DAI received
console.log(result.txHash);    // on-chain transaction hash

// Step 7: Listen for events in real-time
const stream = archon.subscribe({
  vaults: [vault.address],
  events: ['intent.*', 'batch.settled'],
});

stream.on('intent.settled', (event) => {
  console.log(`Swap settled: ${event.amountOut} ${event.tokenOut}`);
});

// Cleanup
await session.revoke();
stream.close();
```

### Core Classes

#### ArchonClient

The entry point. Connects to the chain and solver.

```typescript
class ArchonClient {
  constructor(config: ArchonConfig)

  // Vault operations (operator-level)
  createVault(signer: Signer): Promise<Vault>
  getVault(address: string): Promise<Vault>
  getMyVault(signer: Signer): Promise<Vault | null>  // looks up by operator address

  // Market data (no wallet needed)
  getPairs(): Promise<PairInfo[]>
  getQuote(params: QuoteParams): Promise<Quote>
  getPoolState(pair: string): Promise<PoolState>

  // Event streaming
  subscribe(filter?: SubscribeFilter): EventStream

  // Solver status
  health(): Promise<SolverHealth>
  stats(): Promise<SolverStats>
}
```

#### Vault

Represents an operator's vault. All operator actions go through this.

```typescript
class Vault {
  readonly address: string
  readonly operator: string

  // Initialization (once)
  initialize(config: SafetyConfig): Promise<TxReceipt>

  // Fund management (operator only)
  deposit(token: string | TokenSymbol, amount: string): Promise<TxReceipt>
  withdraw(token: string | TokenSymbol, amount: string, to?: string): Promise<TxReceipt>
  getBalance(token: string | TokenSymbol): Promise<string>
  getBalances(): Promise<Record<string, string>>

  // Safety configuration (operator only)
  updateSafetyConfig(config: Partial<SafetyConfig>): Promise<TxReceipt>
  setTokenAllowed(token: string, allowed: boolean): Promise<TxReceipt>
  freeze(): Promise<TxReceipt>
  unfreeze(): Promise<TxReceipt>
  getSafetyConfig(): Promise<SafetyConfig>
  getSpendingState(): Promise<SpendingState>
  isFrozen(): Promise<boolean>

  // Session keys (operator creates, agent uses)
  createSessionKey(config: SessionKeyConfig): Promise<SessionKey>
  revokeSessionKey(address: string): Promise<TxReceipt>
  getSessionKeys(): Promise<SessionKeyInfo[]>
  isKeyValid(address: string): Promise<boolean>
}
```

#### SessionKey

An agent's trading handle. This is what agents use to submit intents.

```typescript
class SessionKey {
  readonly address: string
  readonly vault: Vault
  readonly permissions: SessionKeyPermissions

  // Trading (the main thing agents do)
  swap(params: SwapParams): Promise<Intent>
  getQuote(params: QuoteParams): Promise<Quote>
  getNonce(): Promise<number>

  // Lifecycle
  revoke(): Promise<TxReceipt>
  isValid(): Promise<boolean>
  expiresAt(): number
  timeUntilExpiry(): number
}
```

#### Intent

A submitted swap intent. Track its lifecycle.

```typescript
class Intent {
  readonly id: string
  readonly vault: string
  readonly tokenIn: string
  readonly tokenOut: string
  readonly amountIn: string
  readonly minAmountOut: string

  // Status tracking
  getStatus(): Promise<IntentStatus>
  waitForSettlement(timeoutMs?: number): Promise<SettlementResult>

  // Events
  on(event: 'matched' | 'settled' | 'refunded' | 'expired', callback: Function): void
}
```

#### EventStream

WebSocket connection to the solver for real-time events.

```typescript
class EventStream {
  on(event: string, callback: (data: any) => void): void
  off(event: string, callback?: Function): void
  close(): void

  // Convenience
  onIntentSettled(callback: (event: IntentSettledEvent) => void): void
  onBatchSettled(callback: (event: BatchSettledEvent) => void): void
  onCircuitBreaker(callback: (event: CircuitBreakerEvent) => void): void
  onPriceChange(callback: (event: PriceChangeEvent) => void): void
}
```

### Types

```typescript
interface ArchonConfig {
  rpcUrl: string
  solverUrl: string
  chainId?: number  // default: 8453 (Base)
  contracts?: Partial<ContractAddresses>  // override defaults
}

interface SafetyConfig {
  maxPerSwap: string         // base units
  maxPerWindow: string       // base units
  windowDuration: number     // seconds
  maxSlippageBps: number     // basis points
  dailyCap: string           // base units
  cooldownPeriod: number     // seconds
  allowedTokens?: string[]   // addresses or symbols
}

interface SessionKeyConfig {
  canSwap?: boolean          // default: true
  canBatchSwap?: boolean     // default: true
  canCrossChainSwap?: boolean // default: false
  maxPerSwapOverride?: string // base units, 0 = use vault default
  expiresIn?: number         // seconds from now, default: 3600
}

interface SwapParams {
  tokenIn: string | TokenSymbol
  tokenOut: string | TokenSymbol
  amountIn: string           // base units
  slippageBps?: number       // default: 50 (0.5%)
  deadline?: number          // unix timestamp, default: now + 5 min
}

interface Quote {
  expectedOut: string
  priceImpactBps: number
  poolFee: string
  spotPrice: string
  pair: string
}

interface SettlementResult {
  amountOut: string
  txHash: string
  blockNumber: number
  matched: boolean           // true if matched peer-to-peer
  poolAmount: string         // amount that went through the pool
  matchedAmount: string      // amount matched directly
  gasCost: string
}

type IntentStatus = 'pending' | 'matching' | 'settling' | 'settled' | 'refunded' | 'expired' | 'failed'

type TokenSymbol = 'USDC' | 'USDT' | 'DAI' | 'WETH' | 'ETH'
```

## Internal Architecture

### Token Resolution

The SDK ships with a built-in token registry for Base. When a user passes 'USDC'
instead of an address, the SDK resolves it. The registry includes the address,
decimals, and symbol for each supported token. Users can also pass raw addresses.

### Intent Signing

This is the most critical internal piece. Intents must be signed in the exact format
the contracts expect. The IntentEngine uses a DIFFERENT signing format from
AgentVault.submitSwapIntent (single swaps). The SDK must sign in the batch format
since everything goes through settleBatch via the solver.

The batch signing format, verified against AgentVault.executeBatchLeg and
SessionKeyManager._verifyAndConsumeNonce (and against the deployed vault on Base):

```
BATCH_INTENT_TAG = keccak256("ARCHON_BATCH_INTENT")
                 = 0x49f0cb72cd3c14cf07a15f3c0ccf497b73c34be55261e3e11e0ec73dd6cfb2de
intentHash  = keccak256(abi.encodePacked(BATCH_INTENT_TAG, tokenIn, tokenOut, amountIn, minAmountOut, deadline))
messageHash = keccak256(abi.encodePacked(intentHash, nonce, vaultAddress, chainId))
signature   = sessionKey.signMessage(ethers.getBytes(messageHash))   // EIP-191 over the 32 raw bytes
```

The single-swap format (AgentVault.submitSwapIntent) is the same WITHOUT the
BATCH_INTENT_TAG prefix. The tag domain-separates the two, so a signature for one is
rejected as the other. The SDK only produces batch signatures. Signatures must be
65 bytes with v ∈ {27, 28} and low s (OpenZeppelin ECDSA); the solver checks this too.

Implementation: src/signing/intent.ts. Proof: test/signing.test.ts (byte-level reference,
solver cross-check, and eth_call against the deployed vault when BASE_RPC_URL is set).
If the contracts change, re-read the Solidity and re-run those tests before anything else.

### Solver Communication

HTTP for submitting intents and queries. WebSocket for event streaming.

- POST /intent: serialize the intent + signature, send to solver
- GET /quote: pass tokenIn, tokenOut, amountIn as query params
- GET /pairs: no params
- GET /status/:intentId: poll for status
- WS /ws: connect, send subscribe message, receive events

The solver API is defined in the archon-solver repo's CLAUDE.md and route handlers.
Read those for the exact request/response shapes.

### Amount Handling

All amounts in the SDK's external API are strings in base units (e.g. "1000000" for
1 USDC). The SDK does NOT do decimal conversion automatically — this prevents floating
point errors. Helper functions are provided:

```typescript
import { parseAmount, formatAmount } from '@plagtech/archon-sdk';

const baseUnits = parseAmount('100.5', 'USDC');  // "100500000"
const human = formatAmount('100500000', 'USDC');  // "100.5"
```

### Contract ABIs

Copy the ABI JSON files from the archon-solver repo (which already extracted them from
the contracts repo). The SDK needs:
- VaultFactory.json (createVault, operatorVault, isVault)
- AgentVault.json (initialize, deposit, withdraw, submitSwapIntent, session key mgmt)
- ArchonRouter.json (quote, getPool)
- IntentEngine.json (for understanding batch format)
- StablePool.json / VolatilePool.json (simulateSwap, spotPrice)
- ERC20.json (approve, balanceOf, allowance — minimal interface)

These are at ../archon-solver/src/chain/abis/

## Project Structure

```
archon-sdk/
├── src/
│   ├── index.ts              # Public exports
│   ├── client.ts             # ArchonClient
│   ├── vault.ts              # Vault class
│   ├── session.ts            # SessionKey class
│   ├── intent.ts             # Intent class
│   ├── events.ts             # EventStream (WebSocket)
│   ├── contracts/
│   │   ├── addresses.ts      # Default contract addresses per chain
│   │   ├── abis/             # Contract ABI JSON files
│   │   └── types.ts          # Generated contract types
│   ├── tokens/
│   │   ├── registry.ts       # Token symbol → address mapping
│   │   └── amounts.ts        # parseAmount, formatAmount helpers
│   ├── signing/
│   │   ├── intent.ts         # Intent signing logic (CRITICAL — must match contracts)
│   │   └── session.ts        # Session key generation
│   └── types.ts              # All public TypeScript types
├── test/
│   ├── client.test.ts
│   ├── vault.test.ts
│   ├── session.test.ts
│   ├── intent.test.ts
│   ├── signing.test.ts       # CRITICAL — verify signatures match contract expectations
│   └── integration.test.ts   # Against Base fork
├── examples/
│   ├── basic-swap.ts         # Minimal example: create vault, deposit, swap
│   ├── agent-trading.ts      # Agent loop: continuous trading with session keys
│   └── event-stream.ts       # Subscribe to events
├── package.json
├── tsconfig.json
├── tsup.config.ts            # Build config (ESM + CJS dual output)
├── .npmrc
├── .gitignore
├── README.md                 # The quick-start example from above
└── CLAUDE.md                 # This file
```

## Build & Publish

### Build

```bash
npm run build    # tsup: ESM + CJS + .d.ts
npm test         # vitest
npm run lint     # eslint + prettier
```

### tsup.config.ts

Dual format build so the package works with both `import` and `require`:

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
});
```

### package.json key fields

```json
{
  "name": "@plagtech/archon-sdk",
  "version": "0.1.0",
  "description": "TypeScript SDK for trading on the Archon DEX — the agent-native decentralized exchange",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "repository": "https://github.com/plagtech/archon-sdk",
  "author": "Plagtech LLC",
  "license": "MIT"
}
```

### Publishing to npm

```bash
npm login          # log in as plagtech
npm publish --access public
```

The @plagtech scope needs to be created on npm first (under the plagtech org or user).

## Build Order

1. **Project scaffold** — package.json, tsconfig, tsup, vitest, .gitignore
2. **Types** — all TypeScript interfaces and types
3. **Token registry + amount helpers** — parseAmount, formatAmount
4. **Contract ABIs** — copy from archon-solver
5. **Signing module** — intent signing that matches the contracts exactly (VERIFY FIRST)
6. **ArchonClient** — constructor, getPairs, getQuote, health
7. **Vault** — createVault, initialize, deposit, withdraw, safety config, balances
8. **SessionKey** — createSessionKey, swap (sign + submit to solver), revoke
9. **Intent** — getStatus, waitForSettlement
10. **EventStream** — WebSocket connection, subscribe, event parsing
11. **Unit tests** — especially signing tests
12. **Integration test** — full flow against Base fork
13. **Examples** — basic-swap.ts, agent-trading.ts, event-stream.ts
14. **README** — the quick-start example from above
15. **Build + publish preparation** (don't actually publish yet — LP approves first)

## Critical Constraints

- The signing module MUST match the contract verification exactly. Read the actual
  Solidity from ../archon/src/ before implementing. Do not guess the signing format.
  A signature mismatch means every intent gets rejected.
- The SDK must work without a browser. No window, no document, no DOM. Agents run
  in Node.js.
- All amounts are strings, never JavaScript numbers (which lose precision above 2^53).
  Use ethers.js BigInt internally.
- The SDK should not hold or store private keys beyond the session. The operator's
  signer and the session key's signer are passed in, not stored.
- Token symbols are convenience aliases, not canonical. The SDK always resolves to
  addresses before making contract calls.

## Testing

Unit tests with vitest. Mock the provider and solver for unit tests.
Integration test against a Base fork (skip without BASE_RPC_URL).

The signing test is the most important: create a vault on a fork, register a session
key, sign an intent with the SDK's signing module, and verify the contract accepts it.
If this test passes, the SDK works. If it fails, nothing works.
