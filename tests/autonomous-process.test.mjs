import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boundedProcess} from '../autonomous/process.mjs';
import {discoverFresh,parseScanReceipt} from '../autonomous/scan.mjs';
import {Ledger} from '../autonomous/ledger.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('supervised CLI preserves a structured rollout refusal without exposing raw diagnostics',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'supervisor-fixture-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'modes'));
  fs.writeFileSync(path.join(root,'cv.md'),'# Synthetic Candidate');
  fs.writeFileSync(path.join(root,'config/profile.yml'),JSON.stringify({candidate:{full_name:'Synthetic Candidate',email:'fixture@example.invalid'},availability:{remote:{earliest_start:'immediate',latest_end:'2027-06-30',max_months:6,max_hours_per_week:40},summer:{earliest_start:'2027-07-01',latest_end:'2027-08-31',max_months:2,max_hours_per_week:40}}}));
  for(const name of ['_profile','_custom'])fs.writeFileSync(path.join(root,`modes/${name}.md`),'Synthetic only');
  const env={...process.env,CAREER_OPS_ROOT:root,CAREER_OPS_DATA_DIR:root,CAREER_OPS_TRACKER:path.join(root,'data/applications.md')};
  await assert.rejects(boundedProcess(process.execPath,[fileURLToPath(new URL('../autonomous-runner.mjs',import.meta.url)),'run','--live'],{env,timeoutMs:10000}),error=>{
    assert.match(JSON.parse(error.stderr).error,/Five complete, current dry runs/);return true;
  });
  const ledger=new Ledger(root);try{assert.equal(ledger.status().attempts.length,0);assert.equal(ledger.status().active,null);}finally{ledger.close();}
});

test('bounded command returns output and terminates stalled work',async()=>{
  assert.equal((await boundedProcess(process.execPath,['-e','process.stdout.write("done")'],{timeoutMs:3000})).stdout,'done');
  await assert.rejects(boundedProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:50}),/deadline/);
});
test('scanner human output and partial exit preserve a valid receipt and successful discoveries',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'partial-scan-fixture-'));
  const ledger=new Ledger(root),token=ledger.acquire();t.after(()=>{ledger.release(token);ledger.close();fs.rmSync(root,{recursive:true,force:true});});
  const receipt={version:'careerops.scan.receipt@1',dry_run:false,scanned:2,found:3,added:1,added_urls:['https://jobs.lever.co/example/new'],errors:[{company:'Broken board',error:'HTTP 404'}]};
  const stdout='Human scan summary\n'+JSON.stringify(receipt)+'\n';
  assert.deepEqual(parseScanReceipt(stdout),receipt);assert.throws(()=>parseScanReceipt('No receipt'));
  const failure=Object.assign(new Error('Partial scan'),{exitCode:2,stdout});
  const result=await discoverFresh(root,ledger,{execute:async(_command,args)=>{
    if(args[0]==='scan.mjs'){fs.writeFileSync(path.join(root,'data/pipeline.md'),'- [ ] https://jobs.lever.co/example/new | Example | Intern\n');throw failure;}
    return {stdout:''};
  }});
  assert.deepEqual(result,receipt);assert.equal(ledger.jobs().length,1);assert.deepEqual(ledger.get('lastDiscovery').receipt,receipt);
});
test('discovery imports partial results and refreshes view even when scan fails',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scan-fixture-'));
  const ledger=new Ledger(root),token=ledger.acquire();t.after(()=>{ledger.release(token);ledger.close();fs.rmSync(root,{recursive:true,force:true});});
  fs.writeFileSync(path.join(root,'data/pipeline.md'),'- [ ] https://jobs.lever.co/example/fixture | Example | Research intern\n');
  const calls=[];
  await assert.rejects(discoverFresh(root,ledger,{execute:async(_command,args)=>{calls.push(args[0]);if(args[0]==='scan.mjs')throw new Error('Fixture scan timeout');return {stdout:''};}}),/scan timeout/);
  assert.deepEqual(calls,['scan.mjs','pipeline-view.mjs']);
  assert.equal(ledger.jobs().length,1);assert.equal(ledger.jobs()[0].state,'discovered');
});
