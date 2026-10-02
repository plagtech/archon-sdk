import { ZeroAddress } from 'ethers';
import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '../src/tokens/amounts.js';
import { findToken, resolveErc20Address, resolveToken, resolveTokenAddress } from '../src/tokens/registry.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('token registry', () => {
  it('resolves symbols case-insensitively', () => {
    expect(resolveTokenAddress('USDC')).toBe(USDC);
    expect(resolveTokenAddress('usdc')).toBe(USDC);
    expect(resolveToken('dai').decimals).toBe(18);
  });

  it('checksums raw addresses and passes unknown ones through', () => {
    expect(resolveTokenAddress(USDC.toLowerCase())).toBe(USDC);
    const unknown = '0x1111111111111111111111111111111111111111';
    expect(resolveTokenAddress(unknown)).toBe(unknown);
    expect(findToken(unknown)).toBeUndefined();
  });

  it('looks up registry tokens by address', () => {
    expect(findToken(USDC.toLowerCase())?.symbol).toBe('USDC');
  });

  it('throws on unknown symbols with the list of known ones', () => {
    expect(() => resolveTokenAddress('PEPE')).toThrow(/Unknown token "PEPE".*USDC, USDT, DAI, WETH, ETH/);
    expect(() => resolveToken('PEPE')).toThrow(/Unknown token/);
  });

  it('refuses to guess decimals for addresses outside the registry', () => {
    expect(() => resolveToken('0x1111111111111111111111111111111111111111')).toThrow(/decimals are unknown/);
  });

  it('treats ETH as native, not WETH, and keeps it out of ERC-20 paths', () => {
    expect(resolveTokenAddress('ETH')).toBe(ZeroAddress);
    expect(resolveToken('ETH').native).toBe(true);
    expect(() => resolveErc20Address('ETH')).toThrow(/use WETH/);
    expect(resolveErc20Address('WETH')).toBe('0x4200000000000000000000000000000000000006');
  });

  it('has no tokens for unknown chains', () => {
    expect(() => resolveTokenAddress('USDC', 1)).toThrow(/chain 1/);
  });
});

describe('amounts', () => {
  it.each([
    ['100.5', 'USDC', '100500000'],
    ['1', 'USDC', '1000000'],
    ['0.000001', 'USDC', '1'],
    ['1.5', 'WETH', '1500000000000000000'],
    ['0', 'DAI', '0'],
    ['1.500000', 'USDC', '1500000'],
  ])('parseAmount(%s, %s) = %s', (human, token, base) => {
    expect(parseAmount(human, token)).toBe(base);
  });

  it.each([
    ['100500000', 'USDC', '100.5'],
    ['1000000', 'USDC', '1'],
    ['1', 'USDC', '0.000001'],
    ['1500000000000000000', 'WETH', '1.5'],
    ['0', 'DAI', '0'],
  ])('formatAmount(%s, %s) = %s', (base, token, human) => {
    expect(formatAmount(base, token)).toBe(human);
  });

  it('is exact beyond 2^53', () => {
    const big = '123456789012345678901234567890';
    expect(parseAmount(formatAmount(big, 'DAI'), 'DAI')).toBe(big);
  });

  it('accepts explicit decimals for unregistered tokens', () => {
    expect(parseAmount('2.5', 8)).toBe('250000000');
    expect(formatAmount('250000000', 8)).toBe('2.5');
  });

  it('never rounds: rejects excess precision', () => {
    expect(() => parseAmount('0.0000001', 'USDC')).toThrow(/more than 6 decimal places/);
  });

  it.each(['-1', '1e6', '', ' 1', '1.', '.5', 'abc'])('rejects malformed amount %j', (bad) => {
    expect(() => parseAmount(bad, 'USDC')).toThrow(/decimal string/);
  });

  it('rejects numbers (precision loss) at runtime', () => {
    expect(() => parseAmount(1.5 as unknown as string, 'USDC')).toThrow(/decimal string/);
    expect(() => formatAmount(1000000 as unknown as string, 'USDC')).toThrow(/integer string/);
  });
});
