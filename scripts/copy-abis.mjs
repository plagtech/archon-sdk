// Refresh src/contracts/abis from the sibling repos.
//   - Five ABIs come from the solver, which already extracted them from the contracts repo.
//   - VaultFactory and ERC20 are not in the solver's set, so they come straight from the
//     contracts repo's Foundry output. ERC20 is trimmed to the functions the SDK calls.
// Usage: node scripts/copy-abis.mjs [solverRepo] [contractsRepo]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const solverRepo = resolve(root, process.argv[2] ?? '../archon-solver');
const contractsRepo = resolve(root, process.argv[3] ?? '../archon');
const outDir = resolve(root, 'src/contracts/abis');

const FROM_SOLVER = ['AgentVault', 'ArchonRouter', 'IntentEngine', 'StablePool', 'VolatilePool'];
const ERC20_FUNCTIONS = new Set(['approve', 'allowance', 'balanceOf', 'decimals', 'symbol', 'transfer']);
const ERC20_EVENTS = new Set(['Transfer', 'Approval']);

function write(name, abi) {
  if (!Array.isArray(abi) || abi.length === 0) throw new Error(`No ABI for ${name}`);
  writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify(abi, null, 2) + '\n');
  console.log(`${name}: ${abi.length} entries`);
}

function foundryAbi(name) {
  return JSON.parse(readFileSync(resolve(contractsRepo, 'out', `${name}.sol`, `${name}.json`), 'utf8')).abi;
}

mkdirSync(outDir, { recursive: true });
for (const name of FROM_SOLVER) {
  write(name, JSON.parse(readFileSync(resolve(solverRepo, 'src/chain/abis', `${name}.json`), 'utf8')));
}
write('VaultFactory', foundryAbi('VaultFactory'));
write(
  'ERC20',
  foundryAbi('ERC20').filter(
    (e) => (e.type === 'function' && ERC20_FUNCTIONS.has(e.name)) || (e.type === 'event' && ERC20_EVENTS.has(e.name)),
  ),
);
