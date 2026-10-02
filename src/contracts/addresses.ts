import type { ContractAddresses } from '../types.js';

export const BASE_CHAIN_ID = 8453;

/** Default deployments by chain id */
export const DEFAULT_ADDRESSES: Readonly<Record<number, Readonly<ContractAddresses>>> = {
  [BASE_CHAIN_ID]: {
    router: '0x45B3042c8a4C2D540a15E89C13B65392d2e14289',
    vaultFactory: '0x58C92a2e7e3b5c3897Ab03466e7f5c1030A40F29',
    intentEngine: '0xf8614FED7664B2505EfD04581f1417D8317648D8',
    spraayAdapter: '0xcF0bE3C00c2D4931315ED524161Dd124626044c2',
    crossChainEscrow: '0xb1eD61a562686B618B4B2856839e65F9B2662321',
  },
};

/** Pools on Base, keyed by pair name */
export const BASE_POOLS = {
  'USDC/USDT': { address: '0x9c77673FBC4aa696a81FFeEead58973E18A1C242', type: 'stable' },
  'USDC/DAI': { address: '0x98B17F4615a5c32C7e3B0b91ba46445f3b582B40', type: 'stable' },
  'USDC/WETH': { address: '0xEed7535E76Ac2ddF8bb649007d28A30b8f3B2CD8', type: 'volatile' },
} as const;

/**
 * Resolve the contract addresses for a chain, applying overrides. Throws if the chain has no
 * default deployment and the overrides don't supply every address.
 */
export function resolveAddresses(chainId: number, overrides: Partial<ContractAddresses> = {}): ContractAddresses {
  const merged = { ...DEFAULT_ADDRESSES[chainId], ...overrides };
  const missing = (['router', 'vaultFactory', 'intentEngine', 'spraayAdapter', 'crossChainEscrow'] as const).filter(
    (k) => !merged[k],
  );
  if (missing.length > 0) {
    throw new Error(`No Archon deployment known for chain ${chainId}; pass contracts.{${missing.join(', ')}}`);
  }
  return merged as ContractAddresses;
}
