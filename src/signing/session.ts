import { Wallet, type Provider } from 'ethers';

/**
 * Generate a fresh session key. The private key exists only in the returned wallet; the SDK
 * never persists it. Hand it to the agent process, register its address on the vault, and
 * let it expire.
 */
export function generateSessionKey(provider?: Provider): Wallet {
  const { privateKey } = Wallet.createRandom();
  return new Wallet(privateKey, provider);
}
