import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Ledger} from '../autonomous/ledger.mjs';
import {sealEmailBundle} from '../autonomous/bundle.mjs';
import {rolloutStatus, authorizeSubmission} from '../autonomous/rollout.mjs';
import {syncReceipt} from '../autonomous/tracker.mjs';
import {hash} from '../autonomous/policy.mjs';

const today='2026-10-23';
function fixture(t,fullScale=true) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'full-scale-applications-'));
  const saved=Object.fromEntries(['CAREER_OPS_ROOT','CAREER_OPS_DATA_DIR','CAREER_OPS_TRACKER'].map(key=>[key,process.env[key]]));
  process.env.CAREER_OPS_ROOT=root;delete process.env.CAREER_OPS_DATA_DIR;
  process.env.CAREER_OPS_TRACKER=path.join(root,'data/applications.md');
  const ledger=new Ledger(root), token=ledger.acquire();
  const fingerprints={cv:'synthetic-cv',procedure:'trusted-procedure',fullScaleApplications:fullScale};
  t.after(()=>{ledger.release(ledger.lockToken || token);ledger.close();for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(root,{recursive:true,force:true});});
  function ready(i,extra={}) {
    const url=`https://employer.invalid/role/${i}`, id=ledger.add(url),bundle=path.join(root,'output',id);
    const job={company:`Synthetic Employer ${i}`,role:'Research intern',track:'remote',deadline:'2026-12-01',start:'2027-01-01',fit:4.5,sourceUrl:url,fingerprints:{...fingerprints,posting:hash(`Posting ${i}`)},bundle,dryRunComplete:true,...extra};
    fs.mkdirSync(bundle,{recursive:true});
    for(const name of ['jd.txt','resume.html','resume.pdf','claims.json','decision.json'])fs.writeFileSync(path.join(bundle,name),`Synthetic fixture ${name}`);
    sealEmailBundle(bundle,job,{to:'jobs@employer.invalid',body:'Synthetic candidate application',claims:[],channel:{verified:true,postingHash:job.fingerprints.posting}});
    ledger.update(id,'ready',job);
    return id;
  }
  return {root,ledger,fingerprints,ready};
}
function reserve(f,id) {
  const state=authorizeSubmission(f.ledger,id,f.fingerprints,'gmail',today);
  return f.ledger.reserve(id,{limit:state.limit,fingerprints:f.ledger.job(id).payload.fingerprints,today});
}

test('full-scale persists twelve independent receipts and canonical applied rows in one day without daily quota',async t=>{
  const f=fixture(t);
  for(let i=0;i<12;i++) {
    const id=f.ready(i);
    assert.equal(rolloutStatus(f.ledger,f.fingerprints,today).stage,'full-scale');
    assert.equal(rolloutStatus(f.ledger,f.fingerprints,today).limit,null);
    reserve(f,id);
    // Simulated transport acceptance; evidence and tracker persistence use the production writers.
    f.ledger.receipt(id,{kind:'gmail-accepted',reference:`synthetic-provider-receipt-${i}`,at:`${today}T12:00:00Z`});
    await syncReceipt(f.root,f.ledger,id);
    assert.equal(f.ledger.job(id).state,'applied');
  }
  const status=rolloutStatus(f.ledger,f.fingerprints,today);
  assert.equal(status.todayAttempts,12);assert.equal(status.verifiedApplications,12);
  assert.equal(JSON.parse(JSON.stringify(status)).limit,null);
  const tracker=fs.readFileSync(process.env.CAREER_OPS_TRACKER,'utf8');
  for(let i=0;i<12;i++)assert.ok(tracker.includes(`synthetic-provider-receipt-${i}`));
  const reopened=new Ledger(f.root);
  try {assert.equal(reopened.status().attempts.length,12);assert.ok(reopened.status().attempts.every(a=>a.outcome==='confirmed'&&JSON.parse(a.receipt).reference));}
  finally {reopened.close();}
});

test('full-scale requires complete individual readiness and retains all authorization safety gates',t=>{
  const f=fixture(t),id=f.ready(0),job=f.ledger.job(id);
  const attempt=()=>reserve(f,id);
  f.ledger.update(id,'exception',{});assert.throws(attempt,/One complete|Incomplete/);
  f.ledger.update(id,'ready',{});
  f.ledger.set('paused',true);assert.throws(attempt,/paused/);f.ledger.set('paused',false);
  f.ledger.set('integrityFailure',{reason:'synthetic failure'});assert.throws(attempt,/Integrity/);f.ledger.set('integrityFailure',null);
  const other=f.ready(1);f.ledger.update(other,'uncertain',{});assert.throws(attempt,/reconciliation/);f.ledger.update(other,'exception',{});
  assert.throws(()=>authorizeSubmission(f.ledger,id,{...f.fingerprints,procedure:'changed'},'gmail',today),/One complete|changed/);
  assert.throws(()=>authorizeSubmission(f.ledger,id,f.fingerprints,'lever',today),/validation pending/);
  fs.appendFileSync(path.join(job.payload.bundle,'email.json'),'tampered');assert.throws(attempt,/One complete|Incomplete/);
  assert.equal(f.ledger.status().attempts.length,0);
});

test('atomic full-scale reservation rejects absent opt-in, stale/unready bundles, missing lock and duplicate intents',t=>{
  const f=fixture(t),id=f.ready(0),fingerprints=f.ledger.job(id).payload.fingerprints;
  f.ledger.set('stage','full-scale');
  const raw=(overrides={})=>f.ledger.reserve(id,{limit:null,fingerprints,today,...overrides});
  assert.throws(()=>raw({limit:Infinity}),/explicit policy/);
  f.ledger.update(id,'ready',{fingerprints:{...fingerprints,fullScaleApplications:false}});
  assert.throws(()=>raw({fingerprints:{...fingerprints,fullScaleApplications:false}}),/explicit policy/);
  f.ledger.update(id,'ready',{fingerprints});
  assert.throws(()=>raw({fingerprints:{...fingerprints,cv:'changed'}}),/Stale/);
  f.ledger.update(id,'exception',{});assert.throws(raw,/Stale/);f.ledger.update(id,'ready',{});
  const token=f.ledger.lockToken;f.ledger.release(token);assert.throws(raw,/active runner lock/);f.ledger.acquire();
  f.ledger.update(id,'ready',{dryRunComplete:false});assert.throws(raw,/Incomplete/);f.ledger.update(id,'ready',{dryRunComplete:true});
  const email=path.join(f.ledger.job(id).payload.bundle,'email.json'),draft=fs.readFileSync(email);
  fs.appendFileSync(email,'tamper');assert.throws(raw,/Incomplete/);fs.writeFileSync(email,draft);
  f.ledger.update(id,'ready',{deadline:'2000-01-01'});assert.throws(raw,/schedule/);f.ledger.update(id,'ready',{deadline:'2026-12-01'});
  raw();assert.throws(raw,/Stale/);
  f.ledger.receipt(id,{kind:'gmail-accepted',reference:'synthetic-duplicate-check'});
  f.ledger.update(id,'ready',{});assert.throws(raw,/UNIQUE/);
  assert.equal(f.ledger.status().attempts.length,1);
});

test('default pilot and initial quotas remain unchanged without full-scale authorization',async t=>{
  const f=fixture(t,false);
  for(let i=0;i<5;i++) {
    const id=f.ready(i);const state=rolloutStatus(f.ledger,f.fingerprints,today);
    assert.equal(state.stage,i<3?'pilot':'initial');assert.equal(state.limit,i<3?3:5);
    reserve(f,id);f.ledger.receipt(id,{kind:'gmail-accepted',reference:`synthetic-normal-${i}`});
    await syncReceipt(f.root,f.ledger,id);
  }
  const sixth=f.ready(5);assert.throws(()=>reserve(f,sixth),/Daily submission limit/);
  assert.equal(f.ledger.status().attempts.length,5);
});
