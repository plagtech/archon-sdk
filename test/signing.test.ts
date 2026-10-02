/**
 * The most important tests in the SDK: if the signature format is wrong, every intent is rejected.
 *
 * Three layers of evidence:
 *   1. An independent byte-level reimplementation of the contract's hashing (no solidityPacked,
 *      no hashMessage) must produce the same digest the SDK signs.
 *   2. The solver's own verifier (../archon-solver) must accept SDK signatures (skipped if absent).
 *   3. The deployed AgentVault on Base must accept them (skipped without BASE_RPC_URL). See below.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Contract,
  JsonRpcProvider,
  Signature,
  SigningKey,
  Wallet,
  computeAddress,
  concat,
  getAddress,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
  type Signer,
} from 'ethers';
import { describe, expect, it } from 'vitest';
import AgentVaultAbi from '../src/contracts/abis/AgentVault.json';
import {
  BATCH_INTENT_TAG,
  batchMessageHash,
  batchSigningDigest,
  normalizeSignature,
  recoverIntentSigner,
  signIntent,
  verifyIntent,
} from '../src/signing/intent.js';
import type { IntentMessage } from '../src/types.js';

const CHAIN_ID = 8453;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DAI = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb';
// Fixed key so failures are reproducible
const KEY = new Wallet('0x' + '11'.repeat(32));

const intent: IntentMessage = {
  vault: '0x8eCc4D824AC4731E1DD677DEEAC131a8677DE8cD',
  tokenIn: USDC,
  tokenOut: DAI,
  amountIn: '1000000',
  minAmountOut: '995000000000000000',
  deadline: 1_900_000_000,
  nonce: 7,
};

// ─── Independent reference implementation ──────────────────────────────────

const u256 = (v: bigint | number) => zeroPadValue(toBeHex(v), 32);
const addr = (a: string) => getAddress(a).toLowerCase(); // 20 bytes, abi.encodePacked(address)

/** Byte-for-byte what AgentVault.executeBatchLeg + SessionKeyManager._verifyAndConsumeNonce hash */
function referenceDigest(i: IntentMessage, chainId: number, tag: string | null = BATCH_INTENT_TAG): string {
  const fields = [
    addr(i.tokenIn),
    addr(i.tokenOut),
    u256(BigInt(i.amountIn)),
    u256(BigInt(i.minAmountOut)),
    u256(i.deadline),
  ];
  const intentHash = keccak256(concat(tag ? [tag, ...fields] : fields));
  const messageHash = keccak256(concat([intentHash, u256(i.nonce), addr(i.vault), u256(chainId)]));
  // MessageHashUtils.toEthSignedMessageHash(bytes32)
  return keccak256(concat([toUtf8Bytes('\x19Ethereum Signed Message:\n32'), messageHash]));
}

function recoverRaw(digest: string, signature: string): string {
  return computeAddress(SigningKey.recoverPublicKey(digest, signature));
}

// ─── 1. Format ──────────────────────────────────────────────────────────────

describe('batch intent digest', () => {
  it('uses keccak256("ARCHON_BATCH_INTENT") as the tag', () => {
    // Pinned literal so an accidental edit to the tag string is caught (also checked on-chain below)
    expect(BATCH_INTENT_TAG).toBe('0x49f0cb72cd3c14cf07a15f3c0ccf497b73c34be55261e3e11e0ec73dd6cfb2de');
  });

  it('matches the byte-level reference implementation', () => {
    expect(batchSigningDigest(intent, CHAIN_ID)).toBe(referenceDigest(intent, CHAIN_ID));
  });

  it('matches the reference with extreme values', () => {
    const edge = { ...intent, amountIn: ((1n << 256n) - 1n).toString(), minAmountOut: '0', nonce: 0, deadline: 0 };
    expect(batchSigningDigest(edge, CHAIN_ID)).toBe(referenceDigest(edge, CHAIN_ID));
  });

  it('is not the single-swap (untagged) digest', () => {
    expect(batchSigningDigest(intent, CHAIN_ID)).not.toBe(referenceDigest(intent, CHAIN_ID, null));
  });

  it('binds every field', () => {
    const base = batchMessageHash(intent, CHAIN_ID);
    const variants: Partial<IntentMessage>[] = [
      { vault: '0x0000000000000000000000000000000000000001' },
      { tokenIn: '0x4200000000000000000000000000000000000006' },
      { tokenOut: '0x4200000000000000000000000000000000000006' },
      { amountIn: '1000001' },
      { minAmountOut: '1' },
      { deadline: intent.deadline + 1 },
      { nonce: intent.nonce + 1 },
    ];
    for (const v of variants) expect(batchMessageHash({ ...intent, ...v }, CHAIN_ID)).not.toBe(base);
    expect(batchMessageHash(intent, 84532)).not.toBe(base);
  });

  it('is independent of address casing', () => {
    const lower = { ...intent, vault: intent.vault.toLowerCase(), tokenIn: USDC.toLowerCase() };
    expect(batchMessageHash(lower, CHAIN_ID)).toBe(batchMessageHash(intent, CHAIN_ID));
  });

  it.each([
    [{ amountIn: '0' }, /amountIn must be positive/],
    [{ amountIn: '1.5' }, /amountIn must be a non-negative integer/],
    [{ amountIn: '-1' }, /amountIn must be a non-negative integer/],
    [{ amountIn: (1n << 256n).toString() }, /exceeds uint256/],
    [{ tokenOut: USDC }, /must differ/],
    [{ vault: '0x1234' }, /vault must be an address/],
    [{ nonce: 1.5 }, /nonce must be a non-negative safe integer/],
    [{ deadline: -1 }, /deadline must be a non-negative safe integer/],
  ])('rejects invalid input %o', (patch, error) => {
    expect(() => batchMessageHash({ ...intent, ...patch } as IntentMessage, CHAIN_ID)).toThrow(error);
  });
});

// ─── 2. Signing ─────────────────────────────────────────────────────────────

describe('signIntent', () => {
  it('produces a signature the reference digest recovers to the session key', async () => {
    const signed = await signIntent(KEY, intent, CHAIN_ID);
    expect(signed.sessionKey).toBe(KEY.address);
    expect(recoverRaw(referenceDigest(intent, CHAIN_ID), signed.signature)).toBe(KEY.address);
    expect(verifyIntent(signed, CHAIN_ID)).toBe(true);
  });

  it('returns the exact POST /intent body shape', async () => {
    const signed = await signIntent(KEY, { ...intent, vault: intent.vault.toLowerCase() }, CHAIN_ID);
    expect(Object.keys(signed).sort()).toEqual(
      [
        'amountIn',
        'deadline',
        'minAmountOut',
        'nonce',
        'sessionKey',
        'signature',
        'tokenIn',
        'tokenOut',
        'vault',
      ].sort(),
    );
    expect(signed.vault).toBe(getAddress(intent.vault));
    expect(typeof signed.amountIn).toBe('string');
    expect(typeof signed.nonce).toBe('number');
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('fails verification under a different chain, vault or nonce', async () => {
    const signed = await signIntent(KEY, intent, CHAIN_ID);
    expect(verifyIntent(signed, 84532)).toBe(false);
    expect(verifyIntent({ ...signed, nonce: signed.nonce + 1 }, CHAIN_ID)).toBe(false);
    expect(verifyIntent({ ...signed, vault: USDC }, CHAIN_ID)).toBe(false);
    expect(verifyIntent({ ...signed, sessionKey: Wallet.createRandom().address }, CHAIN_ID)).toBe(false);
  });

  it('rejects a signer that does not EIP-191-sign the raw hash bytes', async () => {
    // Common mistake: signing the hex string as UTF-8 text instead of the 32 bytes
    const wrong = {
      getAddress: async () => KEY.address,
      signMessage: async (msg: Uint8Array) => KEY.signMessage('0x' + Buffer.from(msg).toString('hex')),
    } as unknown as Signer;
    await expect(signIntent(wrong, intent, CHAIN_ID)).rejects.toThrow(/raw bytes of the message hash/);
  });

  it('normalizes v ∈ {0,1} and high-s signatures from non-ethers signers', async () => {
    const digest = batchSigningDigest(intent, CHAIN_ID);
    const sig = KEY.signingKey.sign(digest);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = concat([sig.r, toBeHex(n - BigInt(sig.s), 32), new Uint8Array([sig.v === 27 ? 1 : 0])]);

    const quirky = {
      getAddress: async () => KEY.address,
      signMessage: async () => highS,
    } as unknown as Signer;
    const signed = await signIntent(quirky, intent, CHAIN_ID);
    expect(signed.signature).toBe(sig.serialized);
    expect(BigInt('0x' + signed.signature.slice(66, 130)) <= n / 2n).toBe(true);
  });

  it('normalizeSignature leaves canonical signatures unchanged', async () => {
    const { signature } = await signIntent(KEY, intent, CHAIN_ID);
    expect(normalizeSignature(signature)).toBe(signature);
    expect(Signature.from(signature).v).toBeGreaterThanOrEqual(27);
  });

  it('recoverIntentSigner returns null for garbage', () => {
    expect(recoverIntentSigner({ ...intent, sessionKey: KEY.address, signature: '0x1234' }, CHAIN_ID)).toBeNull();
  });
});

// ─── 3. Cross-check against the solver's verifier ──────────────────────────

const solverSignature = resolve(__dirname, '../../archon-solver/src/engine/signature.ts');

describe.skipIf(!existsSync(solverSignature))('archon-solver verifier', () => {
  it('accepts SDK signatures and agrees on the digest', async () => {
    const solver = await import(solverSignature);
    const signed = await signIntent(KEY, intent, CHAIN_ID);
    const parsed = { ...signed, amountIn: BigInt(signed.amountIn), minAmountOut: BigInt(signed.minAmountOut) };

    expect(solver.BATCH_INTENT_TAG).toBe(BATCH_INTENT_TAG);
    expect(solver.batchMessageHash(parsed, CHAIN_ID)).toBe(batchMessageHash(intent, CHAIN_ID));
    expect(solver.checkSignatureFormat(signed.signature)).toBeNull();
    expect(solver.recoverBatchSigner(parsed, CHAIN_ID)).toBe(KEY.address);
  });
});

// ─── 4. On-chain: the deployed AgentVault on Base ──────────────────────────
//
// eth_call executeBatchLeg on the live smoke-test vault, from the IntentEngine (the only allowed
// caller). Order of checks in executeBatchLeg: deadline → _verifyAndConsumeNonce (nonce, then
// signature) → _validateSessionKey (active?) → ...
// A fresh random key is unregistered, so its nonce is 0 and it is inactive. Therefore:
//   correct signature → reverts KeyInactive(key)      (signature check PASSED)
//   wrong signature   → reverts InvalidSignature()
// Read-only: eth_call never broadcasts, costs nothing, and changes no state.

const RPC = process.env.BASE_RPC_URL;
const SMOKE_VAULT = '0x8eCc4D824AC4731E1DD677DEEAC131a8677DE8cD';
const INTENT_ENGINE = '0xf8614FED7664B2505EfD04581f1417D8317648D8';

describe.skipIf(!RPC)('deployed AgentVault (Base mainnet, eth_call)', () => {
  const provider = new JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const vault = new Contract(SMOKE_VAULT, AgentVaultAbi, provider);
  const sessionKey = Wallet.createRandom();

  async function revertOf(signature: string, i: IntentMessage, key = sessionKey.address): Promise<string> {
    try {
      await vault
        .getFunction('executeBatchLeg')
        .staticCall(i.tokenIn, i.tokenOut, i.amountIn, i.minAmountOut, i.deadline, i.nonce, key, signature, {
          from: INTENT_ENGINE,
        });
      return 'no revert';
    } catch (err) {
      const e = err as { revert?: { name: string }; shortMessage?: string };
      return e.revert?.name ?? e.shortMessage ?? String(err);
    }
  }

  const liveIntent = (): IntentMessage => ({
    ...intent,
    vault: SMOKE_VAULT,
    nonce: 0,
    deadline: Math.floor(Date.now() / 1000) + 600,
  });

  it('the deployed vault uses the same BATCH_INTENT_TAG and is usable', async () => {
    expect(await vault.getFunction('BATCH_INTENT_TAG')()).toBe(BATCH_INTENT_TAG);
    expect(await vault.getFunction('initialized')()).toBe(true);
    expect(await vault.getFunction('frozen')()).toBe(false);
  });

  it('accepts the SDK signature (fails later, at KeyInactive)', async () => {
    const i = liveIntent();
    const signed = await signIntent(sessionKey, i, CHAIN_ID);
    expect(await revertOf(signed.signature, i)).toBe('KeyInactive');
  });

  it('control: a random session key (not the signer) is rejected', async () => {
    const i = liveIntent();
    const signed = await signIntent(sessionKey, i, CHAIN_ID);
    expect(await revertOf(signed.signature, i, Wallet.createRandom().address)).toBe('InvalidSignature');
  });

  it('rejects a signature over a different field (InvalidSignature)', async () => {
    const i = liveIntent();
    const signed = await signIntent(sessionKey, { ...i, amountIn: '2000000' }, CHAIN_ID);
    expect(await revertOf(signed.signature, i)).toBe('InvalidSignature');
  });

  it('rejects a single-swap (untagged) signature as a batch leg', async () => {
    const i = liveIntent();
    const singleSwapSig = sessionKey.signingKey.sign(referenceDigest(i, CHAIN_ID, null)).serialized;
    expect(await revertOf(singleSwapSig, i)).toBe('InvalidSignature');
  });

  it('rejects a signature from the wrong chain id', async () => {
    const i = liveIntent();
    const signed = await signIntent(sessionKey, i, 84532);
    expect(await revertOf(signed.signature, i)).toBe('InvalidSignature');
  });
});
