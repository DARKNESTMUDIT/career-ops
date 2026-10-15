import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Ledger} from '../autonomous/ledger.mjs';
import {emailDraft} from '../autonomous/gmail.mjs';
import {hash} from '../autonomous/policy.mjs';
import {ADAPTER_VALIDATION} from '../autonomous/rollout.mjs';

// Exercise the unchanged dispatch/reconciliation implementation beyond its
// closed production gate. The test-only module substitutes authorization and
// credential access; it cannot reach Keychain or use the default network.
// This proves transport behavior, not production rollout or provider approval.
let source=fs.readFileSync(new URL('../autonomous/gmail.mjs',import.meta.url),'utf8');
assert.ok(source.includes("import { authorizeSubmission } from './rollout.mjs';"));
source=source.replace("import { authorizeSubmission } from './rollout.mjs';",`function authorizeSubmission(ledger) {
  if (!ledger.ownsLock() || ledger.get('syntheticTransportFixture') !== true) throw new Error('Fixture authorization refused');
  return {limit:3};
}`);
source=source.replace("import { gmailAccess } from './gmail-auth.mjs';","const gmailAccess=()=>{throw new Error('Credentials forbidden in transport fixture');};");
source=source.replace("from './policy.mjs'",`from '${new URL('../autonomous/policy.mjs',import.meta.url).href}'`);
source=source.replace("from './availability.mjs'",`from '${new URL('../autonomous/availability.mjs',import.meta.url).href}'`);
source=source.replaceAll('fetcher=fetch',"fetcher=()=>{throw new Error('Network forbidden in transport fixture');}");
const transport=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmail-transport-fixture-'));
  const ledger=new Ledger(root), token=ledger.acquire();
  t.after(()=>{ledger.release(token);ledger.close();fs.rmSync(root,{recursive:true,force:true});});
  const id=ledger.add('https://employer.invalid/internship');
  const bundle=path.join(root,'bundle');fs.mkdirSync(bundle);
  const context={fingerprints:{cv:'synthetic'},profile:{candidate:{full_name:'Synthetic Candidate',email:'candidate@example.invalid'}},sources:{'cv.md':'Synthetic only','config/profile.yml':'Synthetic only'}};
  const job={bundle,fingerprints:context.fingerprints,sourceUrl:'https://employer.invalid/internship',company:'Synthetic Employer',role:'Synthetic Internship',jd:'Apply at jobs@employer.invalid'};
  const channel={verified:true,roleUrl:job.sourceUrl,sourceUrl:job.sourceUrl,employerHost:'employer.invalid',company:job.company,role:job.role,recipient:'jobs@employer.invalid',quote:job.jd,postingHash:hash(job.jd)};
  fs.writeFileSync(path.join(bundle,'email.json'),JSON.stringify(emailDraft(context,job,channel)));
  fs.writeFileSync(path.join(bundle,'resume.pdf'),'%PDF-1.4 synthetic attachment');
  ledger.update(id,'ready',job);ledger.set('stage','pilot');ledger.set('syntheticTransportFixture',true);
  return {root,ledger,id,context,channel,accessProvider:async()=>({email:context.profile.candidate.email,token:'synthetic-token'})};
}
test('transport harness leaves form adapters closed and changes no production validation',()=>{
  assert.deepEqual(ADAPTER_VALIDATION,{greenhouse:false,lever:false,ashby:false,gmail:true});
});
test('accepted send records immutable intent before exactly one POST and confirms one attempt',async t=>{
  const f=fixture(t);let posts=0;
  const receipt=await transport.sendApplicationEmail({...f,fetcher:async(url,options)=>{
    posts++;assert.equal(options.method,'POST');assert.ok(url.endsWith('/messages/send'));
    assert.equal(f.ledger.job(f.id).state,'submitting');
    assert.equal(f.ledger.status().attempts[0].outcome,'intent');
    const intent=f.ledger.job(f.id).payload.emailIntent;
    const raw=fs.readFileSync(intent.file);
    assert.equal(hash(raw.toString('base64')),intent.rawHash);
    assert.deepEqual(Buffer.from(JSON.parse(options.body).raw,'base64url'),raw);
    return {ok:true,json:async()=>({id:'synthetic-provider-receipt'})};
  }});
  assert.equal(posts,1);assert.equal(receipt.reference,'synthetic-provider-receipt');
  assert.equal(f.ledger.job(f.id).state,'confirmed');
  assert.equal(f.ledger.status().attempts.length,1);
  assert.equal(f.ledger.status().attempts[0].outcome,'confirmed');
});
test('lost send response remains uncertain and recovers by GET without another POST',async t=>{
  const f=fixture(t);let posts=0,gets=0;
  await assert.rejects(transport.sendApplicationEmail({...f,fetcher:async()=>{posts++;throw new Error('Synthetic response loss');}}),/response loss/);
  assert.equal(f.ledger.job(f.id).state,'uncertain');assert.throws(()=>f.ledger.retry(f.id),/Only/);
  const intent=f.ledger.job(f.id).payload.emailIntent;
  const recovered=await transport.reconcileEmail({...f,fetcher:async(url,options)=>{
    gets++;assert.equal(options.method,undefined);
    return {ok:true,json:async()=>url.includes('format=metadata')?{id:'synthetic-provider-receipt',internalDate:'1791547200000',labelIds:['SENT'],payload:{headers:[{name:'From',value:intent.from},{name:'To',value:intent.to},{name:'Message-ID',value:intent.messageId}]}}:{messages:[{id:'synthetic-provider-receipt'}]}};
  }});
  assert.equal(recovered.confirmed,true);assert.equal(posts,1);assert.equal(gets,2);
  assert.equal(f.ledger.status().attempts.length,1);assert.equal(f.ledger.job(f.id).state,'confirmed');
});
test('API error or absent receipt never creates a confirmed outcome or automatic retry',async t=>{
  for(const response of [{ok:false,status:503},{ok:true,json:async()=>({})}]) {
    const f=fixture(t);let calls=0;
    await assert.rejects(transport.sendApplicationEmail({...f,fetcher:async()=>{calls++;return response;}}));
    assert.equal(calls,1);assert.equal(f.ledger.job(f.id).state,'uncertain');
    assert.equal(f.ledger.status().attempts[0].outcome,'intent');
  }
});
test('changed sealed draft or wrong sender refuses before intent and network',async t=>{
  const f=fixture(t);let calls=0;
  const fetcher=async()=>{calls++;throw new Error('Should not send');};
  await assert.rejects(transport.sendApplicationEmail({...f,fetcher,accessProvider:async()=>({email:'wrong@example.invalid',token:'synthetic'})}),/sender mismatch/);
  fs.writeFileSync(path.join(f.ledger.job(f.id).payload.bundle,'email.json'),'{}');
  await assert.rejects(transport.sendApplicationEmail({...f,fetcher}),/differs from sealed/);
  assert.equal(calls,0);assert.equal(f.ledger.status().attempts.length,0);assert.equal(f.ledger.job(f.id).state,'ready');
});
