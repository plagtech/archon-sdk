import type { Provider } from 'ethers';
import type { SolverClient } from './solver.js';
import type { ContractAddresses, WebSocketConstructor } from './types.js';

/** Shared state handed from ArchonClient to the objects it creates. Internal. */
export interface ArchonContext {
  provider: Provider;
  chainId: number;
  addresses: ContractAddresses;
  solver: SolverClient;
  pollIntervalMs: number;
  WebSocket?: WebSocketConstructor;
}

/** Latest block timestamp. Session-key expiry is compared against chain time, not the local clock. */
export async function chainTime(provider: Provider): Promise<number> {
  const block = await provider.getBlock('latest');
  if (!block) throw new Error('Could not read the latest block');
  return block.timestamp;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
