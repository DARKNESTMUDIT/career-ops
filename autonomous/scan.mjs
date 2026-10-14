import {fileURLToPath} from 'node:url';
import {boundedProcess} from './process.mjs';
import {importPipeline} from './runner.mjs';

export function parseScanReceipt(stdout) {
  // The scanner emits a human summary before its final JSON receipt.
  const receipt=JSON.parse(String(stdout).trim().split('\n').at(-1));
  if(receipt?.version!=='careerops.scan.receipt@1' || receipt.dry_run!==false || !Array.isArray(receipt.errors) || !Array.isArray(receipt.added_urls) ||
     ['scanned','found','added'].some(k=>!Number.isSafeInteger(receipt[k])||receipt[k]<0) || receipt.added_urls.some(u=>typeof u!=='string'||!u.startsWith('https://')))throw new Error('Invalid scanner receipt');
  return receipt;
}

export async function discoverFresh(root,ledger,{execute=boundedProcess}={}) {
  if(!ledger.ownsLock())throw new Error('Discovery requires the active runner lock');
  const cwd=fileURLToPath(new URL('../',import.meta.url));
  const env={...process.env,CAREER_OPS_ROOT:root};
  let receipt;
  try {
    try {
      const result=await execute(process.execPath,['scan.mjs','--json','--quiet'],{cwd,env,timeoutMs:300000});
      receipt=parseScanReceipt(result.stdout);
    } catch(error) {
      if(error.exitCode!==2)throw error;
      receipt=parseScanReceipt(error.stdout);
      if(!receipt.errors.length)throw error;
      ledger.event(null,'discovery-partial',{errors:receipt.errors,added:receipt.added});
    }
  } finally {
    // A scanner can persist partial results before a timeout. Always rebuild
    // the user's clickable view and import those results as unqualified jobs.
    try {await execute(process.execPath,['pipeline-view.mjs'],{cwd,env,timeoutMs:30000});}
    finally {importPipeline(ledger,root);}
  }
  ledger.set('lastDiscovery',{at:new Date().toISOString(),receipt});
  return receipt;
}
