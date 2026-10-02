import { ZeroAddress, getAddress, isAddress } from 'ethers';
import { BASE_CHAIN_ID } from '../contracts/addresses.js';
import type { TokenInfo, TokenLike, TokenSymbol } from '../types.js';

const BASE_TOKENS: readonly TokenInfo[] = [
  { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
  { symbol: 'DAI', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
  { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  // AgentVault holds native ether at address(0) (receive / withdrawETH / getBalance(0))
  { symbol: 'ETH', address: ZeroAddress, decimals: 18, native: true },
];

/** ethers' isAddress is a type guard; narrowing a string to never in the else-branch is unhelpful here */
const looksLikeAddress = (value: string): boolean => isAddress(value);

const REGISTRY: Readonly<Record<number, readonly TokenInfo[]>> = {
  [BASE_CHAIN_ID]: BASE_TOKENS,
};

export const TOKEN_SYMBOLS: readonly TokenSymbol[] = ['USDC', 'USDT', 'DAI', 'WETH', 'ETH'];

/** All built-in tokens for a chain (empty for unknown chains) */
export function listTokens(chainId: number = BASE_CHAIN_ID): readonly TokenInfo[] {
  return REGISTRY[chainId] ?? [];
}

/**
 * Look up a built-in token by symbol (case-insensitive) or address. Returns undefined for
 * addresses not in the registry; use resolveToken() when any address should be accepted.
 */
export function findToken(token: TokenLike, chainId: number = BASE_CHAIN_ID): TokenInfo | undefined {
  const tokens = listTokens(chainId);
  if (looksLikeAddress(token)) {
    const address = getAddress(token);
    return tokens.find((t) => t.address === address);
  }
  const symbol = token.toUpperCase();
  return tokens.find((t) => t.symbol === symbol);
}

/**
 * Resolve a symbol or address to a checksummed address. Unknown symbols throw; unknown
 * addresses pass through (the SDK supports tokens outside the registry).
 */
export function resolveTokenAddress(token: TokenLike, chainId: number = BASE_CHAIN_ID): string {
  if (looksLikeAddress(token)) return getAddress(token);
  const info = findToken(token, chainId);
  if (!info) {
    const known = listTokens(chainId).map((t) => t.symbol);
    throw new Error(`Unknown token "${token}" on chain ${chainId}. Pass an address or one of: ${known.join(', ')}`);
  }
  return info.address;
}

/** Resolve to full token info. Throws for addresses not in the registry (decimals unknown). */
export function resolveToken(token: TokenLike, chainId: number = BASE_CHAIN_ID): TokenInfo {
  const info = findToken(token, chainId);
  if (info) return info;
  if (looksLikeAddress(token)) {
    throw new Error(`Token ${token} is not in the built-in registry for chain ${chainId}; its decimals are unknown`);
  }
  // Same error as resolveTokenAddress for unknown symbols
  resolveTokenAddress(token, chainId);
  throw new Error('unreachable');
}

/** Resolve to an ERC-20 address, rejecting native ETH (pools and intents trade WETH) */
export function resolveErc20Address(token: TokenLike, chainId: number = BASE_CHAIN_ID): string {
  const address = resolveTokenAddress(token, chainId);
  if (address === ZeroAddress) {
    throw new Error('Native ETH cannot be traded or deposited as an ERC-20; use WETH');
  }
  return address;
}
