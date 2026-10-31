import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {Ledger} from '../autonomous/ledger.mjs';
import {adapterFor,openForm,prepareForm,submitPrepared,sameJobChannel} from '../autonomous/browser.mjs';
import {prepareApplication,submitReady} from '../autonomous/runner.mjs';
import {reconcileApplicationForm} from '../autonomous-runner.mjs';
import {ARH_NATIVE_SLUG} from '../autonomous/internshala-transport.mjs';
const url=`https://internshala.com/internship/detail/${ARH_NATIVE_SLUG}`;
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-wiring-only-')),ledger=new Ledger(root),token=ledger.acquire();
  t.after(()=>{ledger.release(token);ledger.close();fs.rmSync(root,{recursive:true,force:true});});
  const id=ledger.add(url);ledger.update(id,'eligible',{sourceUrl:url,role:'General Management',company:'Synthetic employer',track:'remote'});
  return {root,ledger,id};
}
test('only exact observed ARH URL resolves native adapter; source variations and other Internshala roles remain unsupported',()=>{
  assert.equal(adapterFor(url),'internshala');
  for(const value of [url+'/',url+'?source=changed',url+'#apply',url.replace('https:','http:'),url.replace('internshala.com','internshala.com.evil.invalid'),url.replace('internshala.com','evil@internshala.com'),url.replace('internshala.com','internshala.com:8443'),url.replace(ARH_NATIVE_SLUG,'different-internship'),url.replace('https://','https://internshala.com@')])assert.equal(adapterFor(value),null,value);
  assert.equal(sameJobChannel(url,url),true);assert.equal(sameJobChannel(url,url+'?changed=1'),false);
});
test('generic navigation, form filling and submit cannot bypass native intent/capture order',async t=>{
  const {ledger,id}=fixture(t);let touched=0;
  const page={url:()=>url,locator:()=>{touched++;throw Error('PII controls must remain untouched');},goto:()=>{touched++;throw Error('Navigation must require original-script attestation');}};
  await assert.rejects(openForm(page,url),/original-script native observation/);
  await assert.rejects(prepareForm(page,{},'/synthetic.pdf'),/generic filling is forbidden/);
  await assert.rejects(submitPrepared(page,{ledger,id,context:{},prepared:{complete:true}}),/guarded native submission adapter/);
  assert.equal(touched,0);assert.equal(ledger.status().attempts.length,0);
});
test('native dry preparation requires actual stored reviewed answers and platform proof before browser access',async t=>{
  const {root,ledger,id}=fixture(t);let launched=0;
  t.mock.method(chromium,'launchPersistentContext',()=>{launched++;throw Error('Browser must not open for missing review');});
  const context={sources:{'cv.md':'Synthetic CV','config/profile.yml':'Synthetic profile','modes/_profile.md':'Synthetic target'},profile:{}};
  await assert.rejects(prepareApplication({root,ledger,id,job:ledger.job(id).payload,context,bundle:ledger.dir}),/Stored reviewed platform resume proof/);
  ledger.update(id,'eligible',{internshalaPlatformResumeReview:{path:path.join(ledger.dir,'absent-review.json'),sha256:'a'.repeat(64)},internshalaAnswers:{reviewed:false,fields:{}}});
  await assert.rejects(prepareApplication({root,ledger,id,job:ledger.job(id).payload,context,bundle:ledger.dir}),/Reviewed mandatory answers/);
  assert.equal(launched,0);assert.equal(ledger.status().attempts.length,0);
});
test('fake ready/complete markers cannot pass actual current bundle and rollout gates independent of adapter registry state',async t=>{
  const {root,ledger,id}=fixture(t);let launched=0;
  t.mock.method(chromium,'launchPersistentContext',()=>{launched++;throw Error('Unverified fake completeness must not open browser');});
  const fingerprints={availabilityMode:'declared',fullScaleApplications:true};
  ledger.update(id,'ready',{dryRunComplete:true,fingerprints,bundle:path.join(ledger.dir,'fake-complete'),deadline:null,start:null});
  await assert.rejects(submitReady({root,ledger,context:{fingerprints,policy:{maximumRunMs:1000}},jobIds:[id]}),/One complete, current verified application/);
  assert.equal(launched,0);assert.equal(ledger.status().attempts.length,0);assert.equal(ledger.job(id).state,'ready');
});
test('unknown form reconciliation providers and missing intents fail before any browser or native send',async t=>{
  const {root,ledger,id}=fixture(t);let launched=0;
  t.mock.method(chromium,'launchPersistentContext',()=>{launched++;throw Error('Provider dispatch must precede browser');});
  await assert.rejects(reconcileApplicationForm({root,ledger,id}),/Existing durable form attempt/);
  ledger.db.prepare('INSERT INTO attempts VALUES (?,?,?,?,NULL)').run('synthetic-dispatch',id,'2026-10-31','intent');ledger.update(id,'uncertain',{formIntent:{provider:'michmer'}});
  await assert.rejects(reconcileApplicationForm({root,ledger,id}),/Unsupported or mismatched/);
  ledger.db.prepare("UPDATE attempts SET outcome='confirmed',receipt=? WHERE job_id=?").run(JSON.stringify({kind:'form-confirmation',provider:'internshala',reference:'synthetic-only'}),id);
  ledger.update(id,'applied',{internshalaIntentFile:path.join(ledger.dir,'absent-original-intent.json')});
  await assert.rejects(reconcileApplicationForm({root,ledger,id}),/ENOENT|Missing or repeated durable native evidence event/);
  assert.equal(launched,0);assert.equal(ledger.status().attempts.length,1);
});
