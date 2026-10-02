import { Interface, Wallet, getAddress } from 'ethers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ADDRESSES } from '../src/contracts/addresses.js';
import { IntentEngineAbi } from '../src/contracts/index.js';
import { nowSec } from '../src/context.js';
import { IntentFailedError, TimeoutError } from '../src/errors.js';
import { Intent } from '../src/intent.js';
import { resolveTokenAddress } from '../src/tokens/registry.js';
import type { IntentStatusInfo, SignedIntent } from '../src/types.js';
import { FakeChain, fakeContext, fakeFetch } from './helpers/fakes.js';

const ENGINE = DEFAULT_ADDRESSES[8453]!.intentEngine;
const USDC = resolveTokenAddress('USDC'); // 0x8335… > 0x50c5… so DAI is tokenA
const DAI = resolveTokenAddress('DAI');
const VAULT = getAddress('0x00000000000000000000000000000000000000aa');
const KEY = Wallet.createRandom().address;
const TX = '0x' + 'ab'.repeat(32);
const engine = new Interface(IntentEngineAbi);

const signed: SignedIntent = {
  vault: VAULT,
  sessionKey: KEY,
  tokenIn: USDC,
  tokenOut: DAI,
  amountIn: '1000',
  minAmountOut: '900',
  deadline: nowSec() + 300,
  nonce: 3,
  signature: '0x',
};

function log(name: string, args: unknown[]) {
  const { topics, data } = engine.encodeEventLog(name, args);
  return { address: ENGINE, topics, data };
}

/** Solver whose /status walks through `sequence`, one entry per poll (the last one repeats) */
function intentWith(sequence: Partial<IntentStatusInfo>[], chain = new FakeChain()) {
  let polls = 0;
  const { fetch } = fakeFetch([
    {
      path: '/status/',
      body: () => ({ intentId: '0xid', ...signed, ...sequence[Math.min(polls++, sequence.length - 1)] }),
    },
  ]);
  const intent = new Intent(fakeContext(chain, fetch), signed, {
    intentId: '0xid',
    status: 'pending',
    estimatedSettlement: 0,
  });
  return { intent, polls: () => polls };
}

describe('Intent', () => {
  it('exposes the signed fields', () => {
    const { intent } = intentWith([{ status: 'pending' }]);
    expect(intent).toMatchObject({
      id: '0xid',
      vault: VAULT,
      amountIn: '1000',
      minAmountOut: '900',
      nonce: 3,
      status: 'pending',
    });
  });

  it('getStatus updates the cached status', async () => {
    const { intent } = intentWith([{ status: 'matched' }]);
    expect(await intent.getStatus()).toBe('matched');
    expect(intent.status).toBe('matched');
  });

  it('waitForSettlement builds the result from the batch transaction logs', async () => {
    const chain = new FakeChain();
    // USDC is tokenB here. 1000 USDC sold by B-sellers (sellB=4000 total); residual is B-side
    // (residualIsA=false) of 2000, so this leg's pool share is 1000 × 2000 / 4000 = 500.
    chain.receipts.set(TX, {
      hash: TX,
      blockNumber: 123,
      gasUsed: 200_000n,
      gasPrice: 5n,
      logs: [
        log('IntentFilled', [7n, VAULT, KEY, 3n, USDC, 1000n, 950n]),
        log('IntentFilled', [7n, VAULT, Wallet.createRandom().address, 0n, USDC, 3000n, 2850n]),
        log('BatchSettled', [7n, DAI, USDC, 10n ** 18n, 1500n, 4000n, 2000n, 1990n, false, 2n]),
      ],
    });
    const { intent } = intentWith(
      [
        { status: 'pending' },
        { status: 'settling' },
        { status: 'settled', txHash: TX, amountOut: '949', batchId: '7' },
      ],
      chain,
    );
    const result = await intent.waitForSettlement(5_000);
    expect(result).toEqual({
      intentId: '0xid',
      amountOut: '950', // on-chain IntentFilled wins over the solver's figure
      txHash: TX,
      blockNumber: 123,
      batchId: '7',
      matched: true,
      poolAmount: '500',
      matchedAmount: '500',
      gasCost: '1000000',
    });
  });

  it('a leg on the fully matched side has no pool portion', async () => {
    const chain = new FakeChain();
    chain.receipts.set(TX, {
      hash: TX,
      blockNumber: 1,
      gasUsed: 1n,
      gasPrice: 1n,
      logs: [
        log('IntentFilled', [1n, VAULT, KEY, 3n, USDC, 1000n, 990n]),
        log('BatchSettled', [1n, DAI, USDC, 10n ** 18n, 5000n, 1000n, 4000n, 3990n, true, 2n]),
      ],
    });
    const { intent } = intentWith([{ status: 'settled', txHash: TX, batchId: '1' }], chain);
    const result = await intent.waitForSettlement(1_000);
    expect(result).toMatchObject({ poolAmount: '0', matchedAmount: '1000', matched: true, amountOut: '990' });
  });

  it.each(['refunded', 'expired', 'failed'] as const)('rejects with IntentFailedError when %s', async (status) => {
    const { intent } = intentWith([{ status: 'pending' }, { status, reason: 'below minAmountOut' }]);
    const err = await intent.waitForSettlement(5_000).catch((e) => e);
    expect(err).toBeInstanceOf(IntentFailedError);
    expect(err).toMatchObject({ status, intentId: '0xid' });
    expect(err.message).toMatch(/below minAmountOut/);
  });

  it('times out', async () => {
    const { intent } = intentWith([{ status: 'pending' }]);
    await expect(intent.waitForSettlement(20)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('on() polls and emits each transition once, then stops', async () => {
    const { intent, polls } = intentWith([
      { status: 'matched' },
      { status: 'matched' },
      { status: 'settling' },
      { status: 'settled', txHash: TX },
    ]);
    const seen: string[] = [];
    await new Promise<void>((resolve) => {
      intent.on('matched', (i) => seen.push(i.status));
      intent.on('settling', (i) => seen.push(i.status));
      intent.on('settled', (i) => {
        seen.push(i.status);
        resolve();
      });
    });
    expect(seen).toEqual(['matched', 'settling', 'settled']);
    const after = polls();
    await new Promise((r) => setTimeout(r, 30));
    expect(polls()).toBe(after);
  });

  it('on() reports polling errors and stops for an unknown intent', async () => {
    const { fetch } = fakeFetch([{ path: '/status/', status: 404, body: { error: 'unknown intent' } }]);
    const intent = new Intent(fakeContext(new FakeChain(), fetch), signed, {
      intentId: '0xid',
      status: 'pending',
      estimatedSettlement: 0,
    });
    const err = await new Promise((resolve) => {
      intent.on('error', resolve);
      intent.on('settled', () => undefined);
    });
    expect(err).toMatchObject({ status: 404 });
  });
});
