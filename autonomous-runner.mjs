#!/usr/bin/env node
import { getCareerOpsRoot } from './path-resolver.mjs';
import { Ledger } from './autonomous/ledger.mjs';
import { run, loadContext } from './autonomous/runner.mjs';
import { connectGmail, reconnectGmail, gmailAccess } from './autonomous/gmail-auth.mjs';
import { retryTrackerSync } from './autonomous/tracker.mjs';
import { reconcileEmail } from './autonomous/gmail.mjs';
import { resolveIntegrityPause } from './autonomous/recovery.mjs';
import { rolloutStatus } from './autonomous/rollout.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { fileURLToPath } from 'node:url';
import { boundedProcess } from './autonomous/process.mjs';
import { discoverFresh } from './autonomous/scan.mjs';
import { reconcileMichmerForm } from './autonomous/michmer-form.mjs';
import {adapterFor} from './autonomous/browser.mjs';
import {reconcileInternshalaApplication,withInternshalaApplicationSession,inspectInternshalaReconciliationState} from './autonomous/internshala-application.mjs';
import {createInternshalaHistorySnapshot} from './autonomous/internshala-history.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export async function reconcileApplicationForm({root,ledger,id}) {
  if(!ledger.ownsLock())throw new Error('Form reconciliation requires active runner lock');
  const job=ledger.job(id),attempt=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
  if(!job || !attempt)throw new Error('Existing durable form attempt required');
  const adapter=adapterFor(job.url);
  if(adapter==='internshala' && typeof job.payload.internshalaIntentFile==='string') {
    if(['confirmed','rejected','aborted-before-send'].includes(attempt.outcome))return reconcileInternshalaApplication({root,ledger,id});
    if(attempt.outcome!=='intent' || !['submitting','uncertain'].includes(job.state))throw new Error('Unresolved native intent required');
    if(!inspectInternshalaReconciliationState({ledger,id}).needsHistory)return reconcileInternshalaApplication({root,ledger,id});
    return withInternshalaApplicationSession(root,async page=>{
      const historySnapshot=createInternshalaHistorySnapshot({directory:path.join(ledger.dir,`internshala-reconcile-history-${randomUUID()}`),root:ledger.dir});
      return reconcileInternshalaApplication({root,ledger,id,page,historySnapshot});
    });
  }
  if(adapter==='michmer' && job.payload.formIntent?.provider==='michmer')return reconcileMichmerForm({ledger,id});
  throw new Error('Unsupported or mismatched form reconciliation provider');
}
export async function main() {
const args = process.argv.slice(2), operation = args[0] || 'status';
try {
  const root = getCareerOpsRoot();
  if (operation === 'run') {
    const ti = args.indexOf('--track');
    const ji = args.indexOf('--job');
    const mi = args.indexOf('--max-evaluations');
    if(args.includes('--worker')) {
      console.log(JSON.stringify(await run({ root, track: ti < 0 ? 'all' : args[ti+1], dryRun: !args.includes('--live'), discover:args.includes('--discover') ? discoverFresh : undefined, jobIds:ji<0?undefined:[args[ji+1]], maxEvaluations:mi<0?30:Number(args[mi+1]) })));
    } else {
      try {
        const result=await boundedProcess(process.execPath,[fileURLToPath(import.meta.url),...args,'--worker'],{env:{...process.env,CAREER_OPS_ROOT:root},timeoutMs:3600000});
        process.stdout.write(result.stdout);
      } catch(error) {
        // Surface only our child's structured error, never arbitrary stderr.
        let message;
        try {const parsed=JSON.parse(error.stderr || '');if(typeof parsed.error==='string' && parsed.error.length<=1000)message=parsed.error;}catch{}
        throw message ? new Error(message) : error;
      }
    }
  } else if (operation === 'discover') {
    const ledger=new Ledger(root);let token;
    try {token=ledger.acquire();console.log(JSON.stringify(await discoverFresh(root,ledger)));}
    finally {if(token)ledger.release(token);ledger.close();}
  } else if (operation === 'gmail-connect' || operation === 'gmail-reconnect') {
    const clientPath=args[1];
    if(operation==='gmail-connect' && !clientPath)throw new Error('Usage: gmail-connect /absolute/path/to/desktop-client.json');
    const {profile}=loadContext(root);
    const connectionOptions={root,clientPath,email:profile.candidate.email,timeoutMs:3600000,onAuthorize:async url=>console.log(JSON.stringify({authorizationUrl:url,instruction:'Open in your signed-in browser; renew the existing Gmail send and read-only access.'}))};
    const result=await (operation==='gmail-reconnect'?reconnectGmail(connectionOptions):connectGmail(connectionOptions));
    const ledger=new Ledger(root); try {ledger.set('gmailConnection',{...result,verifiedAt:new Date().toISOString()});}finally{ledger.close();}
    console.log(JSON.stringify(result));
  } else if (operation === 'gmail-status') {
    const ledger=new Ledger(root);
    try {
      const account=await gmailAccess(root);
      const result={connected:true,email:account.email,storage:'macOS Keychain',verifiedAt:new Date().toISOString()};
      ledger.set('gmailConnection',result);console.log(JSON.stringify(result));
    } catch(error) {
      ledger.set('gmailConnection',{...(ledger.get('gmailConnection') || {}),connected:false,error:error.message,checkedAt:new Date().toISOString()});throw error;
    } finally {ledger.close();}
  } else if (operation === 'gmail-reconcile') {
    const ledger=new Ledger(root); let token;
    try {token=ledger.acquire();console.log(JSON.stringify(await reconcileEmail({root,ledger,id:args[1]})));}
    finally {if(token)ledger.release(token);ledger.close();}
  } else if (operation === 'form-reconcile') {
    const ledger=new Ledger(root);let token;
    try {token=ledger.acquire();console.log(JSON.stringify(await reconcileApplicationForm({root,ledger,id:args[1]})));}
    finally {if(token)ledger.release(token);ledger.close();}
  } else if (operation === 'recover') {
    const ledger=new Ledger(root); let token;
    try {token=ledger.acquire();console.log(JSON.stringify(await resolveIntegrityPause(root,ledger)));}
    finally {if(token)ledger.release(token);ledger.close();}
  } else if (operation === 'sync') {
    const ledger=new Ledger(root); let token;
    try {token=ledger.acquire();console.log(JSON.stringify(await retryTrackerSync(root,ledger)));}
    finally {if(token)ledger.release(token);ledger.close();}
  } else {
    const ledger = new Ledger(root);
    try {
      if (operation === 'pause') { ledger.set('paused', true); ledger.set('pauseReason', 'User paused'); }
      else if (operation === 'resume') ledger.resume();
      else if (operation === 'retry') ledger.retry(args[1]);
      else if (operation === 'add') ledger.add(args[1]);
      else if (operation !== 'status') throw new Error('Use run [--dry-run|--live] [--track all|remote|summer] [--max-evaluations 1..30], discover, status, pause, resume, recover, sync, gmail-status, gmail-connect CLIENT, gmail-reconnect, gmail-reconcile ID, form-reconcile ID, retry ID, or add URL');
      const result=ledger.status();
      if(operation==='status') {
        try {result.rollout=rolloutStatus(ledger,loadContext(root).fingerprints);}
        catch(error){result.rollout={...(result.rollout || {}),reasons:[error.message]};}
      }
      console.log(JSON.stringify(result));
    } finally { ledger.close(); }
  }
} catch (e) { console.error(JSON.stringify({ error: e.message })); process.exitCode = 1; }
}
if (isMainModule(import.meta.url)) await main();
