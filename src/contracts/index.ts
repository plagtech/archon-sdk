import {
  Contract,
  type ContractRunner,
  type JsonFragment,
  type Interface,
  type ContractTransactionResponse,
  type TransactionReceipt,
} from 'ethers';
import { ContractError } from '../errors.js';
import type { TxReceipt } from '../types.js';
import AgentVaultJson from './abis/AgentVault.json';
import ArchonRouterJson from './abis/ArchonRouter.json';
import ERC20Json from './abis/ERC20.json';
import IntentEngineJson from './abis/IntentEngine.json';
import StablePoolJson from './abis/StablePool.json';
import VaultFactoryJson from './abis/VaultFactory.json';

// Typed as plain fragments: the inferred JSON literal types would add ~100 kB to the .d.ts
export const AgentVaultAbi = AgentVaultJson as readonly JsonFragment[];
export const ArchonRouterAbi = ArchonRouterJson as readonly JsonFragment[];
export const ERC20Abi = ERC20Json as readonly JsonFragment[];
export const IntentEngineAbi = IntentEngineJson as readonly JsonFragment[];
export const StablePoolAbi = StablePoolJson as readonly JsonFragment[];
export const VaultFactoryAbi = VaultFactoryJson as readonly JsonFragment[];

export const agentVault = (address: string, runner: ContractRunner) => new Contract(address, AgentVaultAbi, runner);
export const vaultFactory = (address: string, runner: ContractRunner) => new Contract(address, VaultFactoryAbi, runner);
export const archonRouter = (address: string, runner: ContractRunner) => new Contract(address, ArchonRouterAbi, runner);
export const intentEngine = (address: string, runner: ContractRunner) => new Contract(address, IntentEngineAbi, runner);
export const erc20 = (address: string, runner: ContractRunner) => new Contract(address, ERC20Abi, runner);
/** StablePool and VolatilePool share the IArchonPool views the SDK reads (token0/1, getBalances, feeBps, spotPrice) */
export const archonPool = (address: string, runner: ContractRunner) => new Contract(address, StablePoolAbi, runner);

/** Call a contract method by name. Avoids `contract.foo` being `| undefined` under noUncheckedIndexedAccess. */
export function call<T = unknown>(contract: Contract, method: string, ...args: unknown[]): Promise<T> {
  return wrapRevert(() => contract.getFunction(method)(...args) as Promise<T>, method, contract.interface);
}

/** Send a transaction, wait for it to be mined, and summarize the receipt. Reverts become ContractError. */
export async function send(contract: Contract, method: string, ...args: unknown[]): Promise<TxReceipt> {
  const receipt = await sendRaw(contract, method, ...args);
  return toTxReceipt(receipt);
}

export async function sendRaw(contract: Contract, method: string, ...args: unknown[]): Promise<TransactionReceipt> {
  return wrapRevert(
    async () => {
      const tx = await withNonceRetry(
        () => contract.getFunction(method)(...args) as Promise<ContractTransactionResponse>,
      );
      const receipt = await tx.wait();
      if (!receipt) throw new ContractError(`${method} transaction was dropped`, undefined, []);
      return receipt;
    },
    method,
    contract.interface,
  );
}

const NONCE_RETRIES = 3;
const NONCE_RETRY_DELAY_MS = 400;

/**
 * Retry a broadcast the node rejected with "nonce too low". Providers briefly cache
 * eth_getTransactionCount (ethers: 250ms), so a transaction sent right after another one from
 * the same signer can be populated with a stale nonce. A rejected transaction was never
 * accepted, so re-sending (which re-reads the nonce) cannot double-spend.
 */
export async function withNonceRetry<T>(broadcast: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await broadcast();
    } catch (err) {
      if ((err as { code?: string }).code !== 'NONCE_EXPIRED' || attempt >= NONCE_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, NONCE_RETRY_DELAY_MS));
    }
  }
}

export function toTxReceipt(receipt: TransactionReceipt): TxReceipt {
  return {
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    status: receipt.status === 1 ? 'success' : 'reverted',
    gasUsed: receipt.gasUsed.toString(),
  };
}

/** Turn ethers CALL_EXCEPTIONs into ContractError with the decoded custom error, if any */
async function wrapRevert<T>(fn: () => Promise<T>, method: string, iface: Interface): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ContractError) throw err;
    const e = err as {
      code?: string;
      revert?: { name: string; args: unknown[] } | null;
      shortMessage?: string;
      reason?: string | null;
      info?: { error?: { message?: string } };
      data?: string | null;
    };
    if (e.code !== 'CALL_EXCEPTION') throw err;
    // ethers reports some RPC failures (rate limits, node errors) as CALL_EXCEPTION "missing revert
    // data". Those are not reverts; surface them unchanged.
    const rpcMessage = e.info?.error?.message;
    if (!e.revert && !e.data && !e.reason && rpcMessage && !/revert/i.test(rpcMessage)) throw err;
    // ethers decodes custom errors for static calls only; a revert during gas estimation of a send
    // carries the raw data with revert = null, so decode it against the contract's ABI here
    let revert = e.revert ?? undefined;
    if (!revert && typeof e.data === 'string' && e.data.length >= 10) {
      const parsed = iface.parseError(e.data);
      if (parsed) revert = { name: parsed.name, args: [...parsed.args] };
    }
    const args = revert?.args ? [...revert.args] : [];
    const reason = revert?.name;
    const detail = reason
      ? `${reason}(${args.map((a) => (typeof a === 'bigint' ? a.toString() : JSON.stringify(a))).join(', ')})`
      : (e.reason ?? e.shortMessage ?? 'reverted');
    throw new ContractError(`${method} reverted: ${detail}`, reason, args, err);
  }
}
