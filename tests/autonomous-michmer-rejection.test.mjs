import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Ledger} from '../autonomous/ledger.mjs';
import {sealBundle} from '../autonomous/bundle.mjs';
import {hash} from '../autonomous/policy.mjs';
import {integrityPause,rolloutStatus} from '../autonomous/rollout.mjs';
import {resolveIntegrityPause} from '../autonomous/recovery.mjs';
import {MICHMER,MICHMER_TIMING_REJECTION_BODY,reconcileMichmerForm,reconcileMichmerRejection,verifyMichmerRejectedReceipt} from '../autonomous/michmer-form.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const header='| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n';
async function fixture(t,{metadata=false,includeFile=false}={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'michmer-rejection-')));
  const saved=Object.fromEntries(['CAREER_OPS_ROOT','CAREER_OPS_DATA_DIR','CAREER_OPS_TRACKER'].map(key=>[key,process.env[key]]));
  process.env.CAREER_OPS_ROOT=root;delete process.env.CAREER_OPS_DATA_DIR;process.env.CAREER_OPS_TRACKER=path.join(root,'data/applications.md');
  const ledger=new Ledger(root),token=ledger.acquire(),id=ledger.add(MICHMER.source),bundle=path.join(ledger.dir,'bundles',id),fingerprints={fixture:'synthetic'};
  fs.mkdirSync(bundle,{recursive:true});
  const resume=Buffer.from('%PDF-1.4\n'+'Synthetic resume. '.repeat(40)),resumeHash=hash(resume.toString('base64'));
  const prepared={provider:'michmer',complete:true,issues:[],contract:{source:MICHMER.source,endpoint:MICHMER.endpoint,scriptHash:MICHMER.scriptHash},values:{role:MICHMER.role,city:'Other',cityOther:'New Delhi',name:'Synthetic Candidate',email:'candidate@example.invalid',links:'',website:''},resumeName:'resume.pdf',resumeHash,answers:[{type:'file',fileHash:resumeHash}]};
  fs.writeFileSync(path.join(bundle,'resume.pdf'),resume);
  for(const file of ['jd.txt','resume.html','claims.json','decision.json'])fs.writeFileSync(path.join(bundle,file),'Synthetic original fixture');
  sealBundle(bundle,{sourceUrl:MICHMER.source,fingerprints,track:'remote'},prepared);
  ledger.update(id,'ready',{company:'Michmer',role:MICHMER.roleLabel,bundle,fingerprints,track:'remote',start:'2099-01-01',deadline:'2098-12-31',dryRunComplete:true});
  ledger.set('stage','pilot');
  const attempt=ledger.reserve(id,{limit:3,fingerprints}),at=new Date().toISOString();
  ledger.update(id,'submitting',{formIntent:{provider:'michmer',attempt,sourceUrl:MICHMER.source,endpoint:MICHMER.endpoint,bundle,preparedHash:sha(JSON.stringify(prepared)),at}});
  const timestamp=String(Date.now());
  const entries=[...Object.entries(prepared.values),['resumeName',prepared.resumeName],['t',timestamp],['resume',{name:'resume.pdf',type:'application/pdf',base64:resume.toString('base64')}]];
  fs.writeFileSync(path.join(bundle,'michmer-boundary.json'),JSON.stringify({url:MICHMER.endpoint,method:'POST',entries}));
  const form=new FormData();
  for(const[name,value]of entries)if(name!=='resume')form.append(name,value);
  form.append('resume',new Blob([includeFile?resume:Buffer.alloc(0)],{type:'application/pdf'}),'resume.pdf');
  const request=new Request(MICHMER.endpoint,{method:'POST',body:form}),contentType=request.headers.get('content-type'),requestBytes=Buffer.from(await request.arrayBuffer());
  fs.writeFileSync(path.join(bundle,'michmer-request.bin'),requestBytes);
  ledger.event(id,'form-post-evidence',{attempt,requestHash:sha(requestBytes),contentType,requestBodyIncludesFile:includeFile,source:MICHMER.source});
  fs.writeFileSync(path.join(bundle,'michmer-response.txt'),MICHMER_TIMING_REJECTION_BODY);
  if(metadata)fs.writeFileSync(path.join(bundle,'michmer-response-metadata.json'),JSON.stringify({version:1,provider:'michmer',jobId:id,attempt,url:MICHMER.endpoint,status:400,contentType:'application/json',responseHash:sha(MICHMER_TIMING_REJECTION_BODY),at}));
  ledger.update(id,'uncertain',{reasons:['Synthetic observed rejected response requires reconciliation']});
  fs.writeFileSync(process.env.CAREER_OPS_TRACKER,header);
  integrityPause(ledger,'Synthetic submission requires reconciliation');
  t.after(()=>{ledger.release(ledger.lockToken||token);ledger.close();for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(root,{recursive:true,force:true});});
  return {root,ledger,id,bundle,prepared,attempt,tracker:process.env.CAREER_OPS_TRACKER,raw:new Map(['answers.json','resume.pdf','manifest.json','michmer-boundary.json','michmer-request.bin','michmer-response.txt'].map(name=>[name,fs.readFileSync(path.join(bundle,name))]))};
}

test('existing exact timing rejection with unknown HTTP status reconciles without application or retry credit',async t=>{
  const f=await fixture(t),intent=structuredClone(f.ledger.job(f.id).payload.formIntent);
  const result=await reconcileMichmerForm(f);
  assert.equal(result.confirmed,false);assert.equal(result.rejected,true);assert.equal(result.noRetry,true);
  assert.equal(result.receipt.kind,'form-rejected');assert.equal(result.receipt.status,null);assert.equal(result.receipt.observedStatus,'UNKNOWN');
  assert.equal(f.ledger.get('paused'),true);assert.equal(f.ledger.job(f.id).state,'exception');
  const attempt=f.ledger.status().attempts[0];assert.equal(attempt.id,f.attempt);assert.equal(attempt.outcome,'rejected');
  assert.deepEqual(f.ledger.job(f.id).payload.formIntent,intent);
  for(const[name,bytes]of f.raw)assert.deepEqual(fs.readFileSync(path.join(f.bundle,name)),bytes);
  assert.equal(rolloutStatus(f.ledger,{fixture:'synthetic'}).verifiedApplications,0);
  assert.equal(fs.readFileSync(f.tracker,'utf8'),header);
  assert.throws(()=>f.ledger.retry(f.id),/Submission attempt exists/);
  assert.equal((await reconcileMichmerForm(f)).receipt.reference,result.receipt.reference);
  await verifyMichmerRejectedReceipt(f);
  const recovery=await resolveIntegrityPause(f.root,f.ledger);
  assert.equal(recovery.verifiedApplications,0);assert.equal(f.ledger.get('paused'),false);
  assert.equal(f.ledger.status().attempts[0].outcome,'rejected');
});

test('recorded 400 JSON response metadata is verified and status is retained',async t=>{
  const f=await fixture(t,{metadata:true,includeFile:true});
  const result=await reconcileMichmerRejection(f);
  assert.equal(result.receipt.status,400);assert.equal(result.receipt.observedStatus,'400');
  assert.equal((await verifyMichmerRejectedReceipt(f)).receipt.reference,result.receipt.reference);
});

for(const[name,mutate]of [
  ['unknown body',f=>fs.writeFileSync(path.join(f.bundle,'michmer-response.txt'),'{"error":"Rejected"}')],
  ['changed response bytes',f=>fs.appendFileSync(path.join(f.bundle,'michmer-response.txt'),'\n')],
  ['changed request',f=>fs.appendFileSync(path.join(f.bundle,'michmer-request.bin'),'changed')],
  ['changed native PDF',f=>{const file=path.join(f.bundle,'michmer-boundary.json'),body=JSON.parse(fs.readFileSync(file));body.entries.find(([name])=>name==='resume')[1].base64=Buffer.from('wrong PDF').toString('base64');fs.writeFileSync(file,JSON.stringify(body));}],
  ['changed native timestamp',f=>{const file=path.join(f.bundle,'michmer-boundary.json'),body=JSON.parse(fs.readFileSync(file));body.entries.find(([name])=>name==='t')[1]='1234567890123';fs.writeFileSync(file,JSON.stringify(body));}],
  ['changed sealed PDF',f=>fs.appendFileSync(path.join(f.bundle,'resume.pdf'),'changed')],
  ['changed answers',f=>fs.appendFileSync(path.join(f.bundle,'answers.json'),' ')],
  ['changed intent',f=>f.ledger.update(f.id,'uncertain',{formIntent:{...f.ledger.job(f.id).payload.formIntent,attempt:'wrong'}})],
  ['missing post evidence',f=>f.ledger.db.prepare("DELETE FROM events WHERE kind='form-post-evidence'").run()],
  ['conflicting acceptance',f=>fs.writeFileSync(path.join(f.bundle,'michmer-accepted.json'),'{}')],
])test(`rejection refuses ${name} without changing the attempt or pause`,async t=>{
  const f=await fixture(t);mutate(f);
  const before=f.ledger.status().attempts;
  await assert.rejects(reconcileMichmerRejection(f));
  assert.deepEqual(f.ledger.status().attempts,before);assert.equal(f.ledger.get('paused'),true);
});

test('metadata with accepted status, wrong endpoint, content type or response hash cannot prove rejection',async t=>{
  const f=await fixture(t,{metadata:true}),file=path.join(f.bundle,'michmer-response-metadata.json'),original=JSON.parse(fs.readFileSync(file));
  for(const changed of [{status:200},{url:'https://other.com/api/apply'},{responseHash:'wrong'},{contentType:'text/html'},{attempt:'wrong'}]){
    fs.writeFileSync(file,JSON.stringify({...original,...changed}));await assert.rejects(reconcileMichmerRejection(f),/metadata mismatch/);
  }
  assert.equal(f.ledger.status().attempts[0].outcome,'intent');
});

test('reconciliation requires the owned lock and recovery re-verifies rejection artifacts',async t=>{
  const f=await fixture(t),token=f.ledger.lockToken;f.ledger.release(token);
  await assert.rejects(reconcileMichmerRejection(f),/active runner lock/);f.ledger.acquire();
  await reconcileMichmerRejection(f);
  fs.appendFileSync(path.join(f.bundle,'michmer-request.bin'),'changed');
  await assert.rejects(resolveIntegrityPause(f.root,f.ledger));assert.equal(f.ledger.get('paused'),true);
});

test('recovery checks accepted applications normally and excludes rejected attempts from verified application count',async t=>{
  const f=await fixture(t);await reconcileMichmerRejection(f);
  f.ledger.set('paused',false);f.ledger.set('integrityFailure',null);f.ledger.set('stage','initial');
  const id=f.ledger.add('https://employer.com/accepted');f.ledger.update(id,'ready',{company:'Accepted Employer',role:'Research Intern',fingerprints:{fixture:true}});
  f.ledger.reserve(id,{limit:5,fingerprints:{fixture:true}});f.ledger.receipt(id,{kind:'gmail-accepted',reference:'synthetic-accepted'});
  f.ledger.update(id,'applied',{trackerSync:{verified:true,row:1,path:f.tracker}});
  fs.writeFileSync(f.tracker,header+`| 1 | 2026-10-23 | Accepted Employer | Research Intern | 4/5 | Applied | - | - | [autonomous:${id}] https://employer.com/accepted; receipt gmail-accepted: synthetic-accepted |\n`);
  integrityPause(f.ledger,'Synthetic mixed receipt recovery');
  assert.equal((await resolveIntegrityPause(f.root,f.ledger)).verifiedApplications,1);
  assert.equal(f.ledger.status().attempts.length,2);
});
