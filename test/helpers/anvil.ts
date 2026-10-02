import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AbiCoder, Contract, JsonRpcProvider, keccak256, toBeHex, zeroPadValue, type Provider } from 'ethers';

/** anvil from ANVIL_PATH, ~/.foundry/bin, or PATH */
export function findAnvil(): string | undefined {
  if (process.env.ANVIL_PATH) return process.env.ANVIL_PATH;
  const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  const foundry = join(homedir(), '.foundry', 'bin', exe);
  if (existsSync(foundry)) return foundry;
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  return undefined;
}

export interface Anvil {
  url: string;
  provider: JsonRpcProvider;
  stop(): void;
}

/** Start anvil forking `forkUrl` and wait until it answers RPC */
export async function startAnvil(binary: string, forkUrl: string, port: number): Promise<Anvil> {
  const proc: ChildProcess = spawn(binary, ['--fork-url', forkUrl, '--port', String(port), '--silent'], {
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(url, 8453, { staticNetwork: true, pollingInterval: 250 });
  const started = Date.now();
  for (;;) {
    try {
      await provider.getBlockNumber();
      break;
    } catch {
      if (proc.exitCode !== null) throw new Error(`anvil exited with code ${proc.exitCode}`);
      if (Date.now() - started > 60_000) {
        proc.kill();
        throw new Error('anvil did not start within 60s');
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return {
    url,
    provider,
    stop: () => {
      provider.destroy();
      proc.kill();
    },
  };
}

/** Give `holder` an ERC-20 balance by finding the balances mapping slot (a forge `deal` equivalent) */
export async function dealErc20(provider: JsonRpcProvider, token: string, holder: string, amount: bigint) {
  const contract = new Contract(token, ['function balanceOf(address) view returns (uint256)'], provider as Provider);
  for (let slot = 0; slot < 30; slot++) {
    const key = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [holder, slot]));
    const previous = await provider.send('eth_getStorageAt', [token, key, 'latest']);
    await provider.send('anvil_setStorageAt', [token, key, zeroPadValue(toBeHex(amount), 32)]);
    if ((await contract.getFunction('balanceOf')(holder)) === amount) return;
    await provider.send('anvil_setStorageAt', [token, key, previous]);
  }
  throw new Error(`Could not find the balance slot of ${token}`);
}

/** Send transactions from any address (e.g. the protocol admin) */
export async function impersonate(provider: JsonRpcProvider, address: string) {
  await provider.send('anvil_impersonateAccount', [address]);
  await provider.send('anvil_setBalance', [address, toBeHex(10n ** 20n)]);
  return provider.getSigner(address);
}
