/**
 * Batch-intent signing. This MUST match the on-chain verification exactly, or every intent is
 * rejected. Verified against archon/src:
 *
 *   AgentVault.executeBatchLeg:
 *     intentHash = keccak256(abi.encodePacked(
 *         BATCH_INTENT_TAG, tokenIn, tokenOut, amountIn, minAmountOut, deadline))
 *     where BATCH_INTENT_TAG = keccak256("ARCHON_BATCH_INTENT")
 *
 *   SessionKeyManager._verifyAndConsumeNonce:
 *     messageHash = keccak256(abi.encodePacked(intentHash, nonce, address(this), block.chainid))
 *     ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(messageHash), signature) == sessionKey
 *     nonce == sessionKeys[sessionKey].nonce
 *
 * So the session key EIP-191-signs the 32 raw bytes of messageHash (`signMessage(getBytes(h))`).
 *
 * The tag is what distinguishes batch intents from single swaps (AgentVault.submitSwapIntent
 * hashes the same fields WITHOUT the tag), so a signature for one can never be replayed as
 * the other. All SDK swaps settle through the solver → IntentEngine.settleBatch →
 * executeBatchLeg, so the SDK only produces batch signatures.
 *
 * The solver re-verifies off-chain with the same digest (archon-solver/src/engine/signature.ts)
 * and rejects anything that does not recover to sessionKey.
 */
import {
  Signature,
  getAddress,
  getBytes,
  hashMessage,
  isAddress,
  keccak256,
  recoverAddress,
  solidityPackedKeccak256,
  toUtf8Bytes,
  type Signer,
} from 'ethers';
import { toBigInt } from '../tokens/amounts.js';
import type { IntentMessage, SignedIntent } from '../types.js';

/** AgentVault.BATCH_INTENT_TAG = keccak256("ARCHON_BATCH_INTENT") */
export const BATCH_INTENT_TAG = keccak256(toUtf8Bytes('ARCHON_BATCH_INTENT'));

const UINT256_MAX = (1n << 256n) - 1n;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** OpenZeppelin ECDSA rejects s above n/2 (malleability guard) */
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

/** Checked, normalized form of an IntentMessage */
interface NormalizedIntent {
  vault: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
  deadline: number;
  nonce: number;
}

function address(value: string, name: string): string {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`${name} must be an address, got ${value}`);
  return getAddress(value);
}

function uint256(value: string, name: string): bigint {
  const parsed = toBigInt(value, name);
  if (parsed > UINT256_MAX) throw new Error(`${name} exceeds uint256`);
  return parsed;
}

/** The solver requires deadline and nonce as JSON numbers, so they must be safe integers */
function safeUint(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer, got ${value}`);
  }
  return value;
}

function normalize(intent: IntentMessage): NormalizedIntent {
  const normalized: NormalizedIntent = {
    vault: address(intent.vault, 'vault'),
    tokenIn: address(intent.tokenIn, 'tokenIn'),
    tokenOut: address(intent.tokenOut, 'tokenOut'),
    amountIn: uint256(intent.amountIn, 'amountIn'),
    minAmountOut: uint256(intent.minAmountOut, 'minAmountOut'),
    deadline: safeUint(intent.deadline, 'deadline'),
    nonce: safeUint(intent.nonce, 'nonce'),
  };
  if (normalized.tokenIn === normalized.tokenOut) throw new Error('tokenIn and tokenOut must differ');
  if (normalized.amountIn === 0n) throw new Error('amountIn must be positive');
  return normalized;
}

/** intentHash as built by AgentVault.executeBatchLeg */
export function batchIntentHash(intent: IntentMessage): string {
  const i = normalize(intent);
  return solidityPackedKeccak256(
    ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256'],
    [BATCH_INTENT_TAG, i.tokenIn, i.tokenOut, i.amountIn, i.minAmountOut, i.deadline],
  );
}

/** messageHash as built by SessionKeyManager._verifyAndConsumeNonce (before the EIP-191 prefix) */
export function batchMessageHash(intent: IntentMessage, chainId: number): string {
  const i = normalize(intent);
  safeUint(chainId, 'chainId');
  return solidityPackedKeccak256(
    ['bytes32', 'uint256', 'address', 'uint256'],
    [batchIntentHash(intent), i.nonce, i.vault, chainId],
  );
}

/** The digest ECDSA.recover runs on: toEthSignedMessageHash(messageHash) */
export function batchSigningDigest(intent: IntentMessage, chainId: number): string {
  return hashMessage(getBytes(batchMessageHash(intent, chainId)));
}

/**
 * Bring a signature into the form OpenZeppelin ECDSA.recover accepts: 65 bytes, v ∈ {27, 28},
 * s ≤ n/2. Some signers (hardware, KMS) return v ∈ {0, 1} or high s; both have an equivalent
 * canonical form, so normalize rather than reject.
 */
export function normalizeSignature(signature: string): string {
  const bytes = getBytes(signature);
  if (bytes.length !== 65) throw new Error(`signature must be 65 bytes, got ${bytes.length}`);
  const r = '0x' + signature.slice(2, 66);
  let s = BigInt('0x' + signature.slice(66, 130));
  let v = bytes[64]!;
  if (v < 27) v += 27;
  if (v !== 27 && v !== 28) throw new Error(`signature has invalid v ${bytes[64]}`);
  if (s > SECP256K1_HALF_N) {
    s = SECP256K1_N - s;
    v = v === 27 ? 28 : 27;
  }
  return Signature.from({ r, s: '0x' + s.toString(16).padStart(64, '0'), v }).serialized;
}

/**
 * Sign a batch intent with a session key. Returns the exact body for the solver's POST /intent.
 * The signature is checked to recover to the signer's address before it is returned, so a
 * signer that hashes differently fails here rather than at the solver.
 */
export async function signIntent(sessionKey: Signer, intent: IntentMessage, chainId: number): Promise<SignedIntent> {
  const i = normalize(intent);
  const signerAddress = getAddress(await sessionKey.getAddress());
  const raw = await sessionKey.signMessage(getBytes(batchMessageHash(intent, chainId)));
  const signature = normalizeSignature(raw);

  const signed: SignedIntent = {
    vault: i.vault,
    sessionKey: signerAddress,
    tokenIn: i.tokenIn,
    tokenOut: i.tokenOut,
    amountIn: i.amountIn.toString(),
    minAmountOut: i.minAmountOut.toString(),
    deadline: i.deadline,
    nonce: i.nonce,
    signature,
  };
  const recovered = recoverIntentSigner(signed, chainId);
  if (recovered !== signerAddress) {
    throw new Error(
      `Signer produced a signature recovering to ${recovered}, not ${signerAddress}. ` +
        'It must EIP-191 sign the 32 raw bytes of the message hash.',
    );
  }
  return signed;
}

/** Recover the session key that signed an intent, as the vault would. Null if unrecoverable. */
export function recoverIntentSigner(intent: SignedIntent, chainId: number): string | null {
  try {
    return recoverAddress(batchSigningDigest(intent, chainId), Signature.from(intent.signature));
  } catch {
    return null;
  }
}

/** True if `intent.signature` is a valid batch-intent signature by `intent.sessionKey` */
export function verifyIntent(intent: SignedIntent, chainId: number): boolean {
  const recovered = recoverIntentSigner(intent, chainId);
  return recovered !== null && isAddress(intent.sessionKey) && recovered === getAddress(intent.sessionKey);
}
