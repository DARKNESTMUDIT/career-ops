#!/usr/bin/env node
import { getCareerOpsRoot } from './path-resolver.mjs';
import { Ledger } from './autonomous/ledger.mjs';
import { run } from './autonomous/runner.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
export async function main() {
const args = process.argv.slice(2), operation = args[0] || 'status';
try {
  const root = getCareerOpsRoot();
  if (operation === 'run') {
    const ti = args.indexOf('--track');
    console.log(JSON.stringify(await run({ root, track: ti < 0 ? 'all' : args[ti+1], dryRun: !args.includes('--live') })));
  } else {
    const ledger = new Ledger(root);
    try {
      if (operation === 'pause') { ledger.set('paused', true); ledger.set('pauseReason', 'User paused'); }
      else if (operation === 'resume') { ledger.set('paused', false); ledger.set('pauseReason', null); }
      else if (operation === 'retry') ledger.retry(args[1]);
      else if (operation === 'add') ledger.add(args[1]);
      else if (operation !== 'status') throw new Error('Use run [--dry-run] [--track all|remote|summer], status, pause, resume, retry ID, or add URL');
      console.log(JSON.stringify(ledger.status()));
    } finally { ledger.close(); }
  }
} catch (e) { console.error(JSON.stringify({ error: e.message })); process.exitCode = 1; }
}
if (isMainModule(import.meta.url)) await main();
