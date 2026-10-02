import { formatUnits, parseUnits } from 'ethers';
import { BASE_CHAIN_ID } from '../contracts/addresses.js';
import type { TokenLike } from '../types.js';
import { resolveToken } from './registry.js';

const DECIMAL_STRING = /^\d+(\.\d+)?$/;
const BASE_UNITS = /^\d+$/;

function decimalsOf(token: TokenLike | number, chainId: number): number {
  return typeof token === 'number' ? token : resolveToken(token, chainId).decimals;
}

/**
 * Convert a human amount to base units: parseAmount('100.5', 'USDC') → '100500000'.
 * Pass a number of decimals instead of a token for tokens outside the registry.
 * Throws if the amount has more fractional digits than the token supports (never rounds).
 */
export function parseAmount(amount: string, token: TokenLike | number, chainId: number = BASE_CHAIN_ID): string {
  if (typeof amount !== 'string' || !DECIMAL_STRING.test(amount)) {
    throw new Error(`Amount must be a non-negative decimal string, got ${JSON.stringify(amount)}`);
  }
  const decimals = decimalsOf(token, chainId);
  const fraction = amount.split('.')[1] ?? '';
  if (fraction.replace(/0+$/, '').length > decimals) {
    throw new Error(`Amount ${amount} has more than ${decimals} decimal places`);
  }
  return parseUnits(amount, decimals).toString();
}

/**
 * Convert base units to a human amount: formatAmount('100500000', 'USDC') → '100.5'.
 * Whole amounts have no trailing ".0".
 */
export function formatAmount(
  amount: string | bigint,
  token: TokenLike | number,
  chainId: number = BASE_CHAIN_ID,
): string {
  const value = typeof amount === 'bigint' ? amount : toBigInt(amount, 'amount');
  const formatted = formatUnits(value, decimalsOf(token, chainId));
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
}

/** Parse a base-units string to bigint, rejecting anything that isn't a non-negative integer */
export function toBigInt(value: string, name: string): bigint {
  if (typeof value !== 'string' || !BASE_UNITS.test(value)) {
    throw new Error(`${name} must be a non-negative integer string of base units, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}
