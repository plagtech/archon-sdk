export * from './types.js';

export { ArchonClient } from './client.js';
export { Vault, validateSafetyConfig, DEFAULT_SESSION_KEY_TTL } from './vault.js';
export { SessionKey, nextFreeNonce, DEFAULT_SLIPPAGE_BPS, DEFAULT_DEADLINE_SEC } from './session.js';
export { Intent, isTerminal, type IntentEventName } from './intent.js';
export { EventStream, type EventStreamOptions, type SolverEventMap, type StreamLifecycleMap } from './events.js';
export { SolverClient, type SolverClientOptions, type FetchLike } from './solver.js';
export { ArchonError, ContractError, IntentFailedError, SolverError, TimeoutError } from './errors.js';

export { BASE_CHAIN_ID, BASE_POOLS, DEFAULT_ADDRESSES, resolveAddresses } from './contracts/addresses.js';
export {
  AgentVaultAbi,
  ArchonRouterAbi,
  ERC20Abi,
  IntentEngineAbi,
  StablePoolAbi,
  VaultFactoryAbi,
} from './contracts/index.js';

export {
  TOKEN_SYMBOLS,
  findToken,
  listTokens,
  resolveErc20Address,
  resolveToken,
  resolveTokenAddress,
} from './tokens/registry.js';
export { formatAmount, parseAmount } from './tokens/amounts.js';

export {
  BATCH_INTENT_TAG,
  batchIntentHash,
  batchMessageHash,
  batchSigningDigest,
  normalizeSignature,
  recoverIntentSigner,
  signIntent,
  verifyIntent,
} from './signing/intent.js';
export { generateSessionKey } from './signing/session.js';
