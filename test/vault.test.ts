import { Wallet, getAddress } from 'ethers';
import { describe, expect, it } from 'vitest';
import { AgentVaultAbi } from '../src/contracts/index.js';
import { resolveTokenAddress } from '../src/tokens/registry.js';
import { Vault, validateSafetyConfig } from '../src/vault.js';
import { FakeChain, fakeContext, fakeFetch } from './helpers/fakes.js';

const VAULT = getAddress('0x00000000000000000000000000000000000000aa');
const operatorWallet = new Wallet('0x' + '22'.repeat(32));
const USDC = resolveTokenAddress('USDC');

const config = {
  maxPerSwap: '100',
  maxPerWindow: '500',
  windowDuration: 3600,
  maxSlippageBps: 50,
  dailyCap: '1000',
  cooldownPeriod: 300,
};

function vaultWith(handlers: Record<string, (...a: never[]) => unknown>, signer?: Wallet) {
  const chain = new FakeChain().register(VAULT, AgentVaultAbi, handlers);
  const ctx = fakeContext(chain, fakeFetch([]).fetch);
  return { vault: new Vault(ctx, VAULT, operatorWallet.address, signer?.connect(chain.provider)), chain };
}

describe('validateSafetyConfig (mirrors SafetyModule._updateSafetyConfig)', () => {
  it('accepts a valid config and returns contract-ordered bigints', () => {
    expect(validateSafetyConfig(config)).toEqual({
      maxPerSwap: 100n,
      maxPerWindow: 500n,
      windowDuration: 3600n,
      maxSlippageBps: 50n,
      dailyCap: 1000n,
      cooldownPeriod: 300n,
    });
  });

  it.each([
    [{ maxPerSwap: '0' }, /maxPerSwap cannot be zero/],
    [{ maxPerWindow: '0' }, /maxPerWindow cannot be zero/],
    [{ windowDuration: 0 }, /windowDuration cannot be zero/],
    [{ maxSlippageBps: 0 }, /maxSlippageBps must be 1–1000/],
    [{ maxSlippageBps: 1001 }, /maxSlippageBps must be 1–1000/],
    [{ dailyCap: '0' }, /dailyCap cannot be zero/],
    [{ dailyCap: '400' }, /dailyCap must be >= maxPerWindow/],
    [{ maxPerSwap: '600' }, /maxPerWindow must be >= maxPerSwap/],
    [{ cooldownPeriod: -1 }, /cooldownPeriod must be a non-negative integer/],
    [{ maxPerSwap: '1.5' }, /integer string/],
  ])('rejects %o', (patch, error) => {
    expect(() => validateSafetyConfig({ ...config, ...patch })).toThrow(error);
  });

  it('allows a zero cooldown', () => {
    expect(validateSafetyConfig({ ...config, cooldownPeriod: 0 }).cooldownPeriod).toBe(0n);
  });
});

describe('Vault reads', () => {
  it('maps getSafetyConfig and getSpendingState to strings and numbers', async () => {
    const { vault } = vaultWith({
      getSafetyConfig: () => [100n, 500n, 3600n, 50n, 1000n, 300n],
      getSpendingState: () => [7n, 3n, 1000n, 500n, true],
    });
    expect(await vault.getSafetyConfig()).toEqual(config);
    expect(await vault.getSpendingState()).toEqual({
      dailySpent: '7',
      windowSpent: '3',
      dailyCap: '1000',
      maxPerWindow: '500',
      frozen: true,
    });
  });

  it('getBalances covers every registry token including native ETH', async () => {
    const { vault, chain } = vaultWith({ getBalance: (t: string) => (t === USDC ? 5_000_000n : 0n) });
    const balances = await vault.getBalances();
    expect(balances).toEqual({ USDC: '5000000', USDT: '0', DAI: '0', WETH: '0', ETH: '0' });
    expect(chain.calls.map((c) => c.args[0])).toContain('0x0000000000000000000000000000000000000000');
  });

  it('getSessionKeys dedupes keys registered more than once', async () => {
    const k1 = Wallet.createRandom().address;
    const k2 = Wallet.createRandom().address;
    const { vault } = vaultWith({
      getRegisteredKeyCount: () => 3n,
      registeredKeys: (i: bigint) => [k1, k2, k1][Number(i)],
      sessionKeys: (k: string) => [k === k2, true, true, false, 0n, 1_900_000_000n, 4n, 10n, 1_800_000_000n],
    });
    const keys = await vault.getSessionKeys();
    expect(keys.map((k) => k.address)).toEqual([k1, k2]);
    expect(keys[1]).toEqual({
      address: k2,
      active: true,
      canSwap: true,
      canBatchSwap: true,
      canCrossChainSwap: false,
      maxPerSwapOverride: '0',
      expiry: 1_900_000_000,
      nonce: 4,
      totalSpent: '10',
      registeredAt: 1_800_000_000,
    });
  });
});

describe('Vault operator guard', () => {
  it('read-only vaults refuse operator actions', async () => {
    const { vault } = vaultWith({});
    await expect(vault.freeze()).rejects.toThrow(/without a signer/);
  });

  it('a non-operator signer is refused before any transaction', async () => {
    const { vault } = vaultWith({}, new Wallet(Wallet.createRandom().privateKey));
    await expect(vault.setTokenAllowed('USDC', true)).rejects.toThrow(/is not the operator/);
  });

  it('initialize validates locally and refuses an initialized vault', async () => {
    const { vault } = vaultWith({ initialized: () => true }, operatorWallet);
    await expect(vault.initialize({ ...config, maxSlippageBps: 5000 })).rejects.toThrow(/maxSlippageBps/);
    await expect(vault.initialize({ ...config, allowedTokens: ['ETH'] })).rejects.toThrow(/use WETH/);
    await expect(vault.initialize(config)).rejects.toThrow(/already initialized/);
  });

  it('updateSafetyConfig merges with current values and validates', async () => {
    const { vault } = vaultWith({ getSafetyConfig: () => [100n, 500n, 3600n, 50n, 1000n, 300n] }, operatorWallet);
    await expect(vault.updateSafetyConfig({ maxPerWindow: '50' })).rejects.toThrow(
      /maxPerWindow must be >= maxPerSwap/,
    );
    await expect(vault.updateSafetyConfig({ allowedTokens: ['USDC'] } as never)).rejects.toThrow(/setTokenAllowed/);
  });

  it('unfreeze reports the remaining cooldown', async () => {
    const { vault, chain } = vaultWith(
      { frozenAt: () => 1_800_000_000n, cooldownPeriod: () => 300n, frozen: () => true },
      operatorWallet,
    );
    chain.timestamp = 1_800_000_100;
    await expect(vault.unfreeze()).rejects.toThrow(/cooldown has 200s left/);
  });

  it('registerSessionKey validates config before sending', async () => {
    const { vault } = vaultWith({ getSafetyConfig: () => [100n, 500n, 3600n, 50n, 1000n, 300n] }, operatorWallet);
    const key = Wallet.createRandom().address;
    await expect(vault.registerSessionKey(key, { canSwap: false, canBatchSwap: false })).rejects.toThrow(
      /at least one permission/,
    );
    await expect(vault.registerSessionKey(key, { expiresIn: 0 })).rejects.toThrow(/expiresIn/);
    await expect(vault.registerSessionKey(key, { maxPerSwapOverride: '101' })).rejects.toThrow(
      /exceeds the vault's maxPerSwap/,
    );
    await expect(vault.registerSessionKey('0x123')).rejects.toThrow(/not an address/);
  });

  it('deposit and withdraw validate amounts', async () => {
    const { vault } = vaultWith({}, operatorWallet);
    await expect(vault.deposit('USDC', '0')).rejects.toThrow(/positive/);
    await expect(vault.deposit('USDC', '1.5')).rejects.toThrow(/integer string/);
    await expect(vault.withdraw('USDC', '1', 'not-an-address')).rejects.toThrow(/not an address/);
  });
});
