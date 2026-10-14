import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Ledger} from '../autonomous/ledger.mjs';
import {applicationMime,emailDraft,reconcileEmail,sendApplicationEmail} from '../autonomous/gmail.mjs';
import {hash} from '../autonomous/policy.mjs';

const intent={from:'candidate@example.invalid',to:'jobs@employer.invalid',messageId:'<fixture-id@career-ops.invalid>'};
function ledgerFixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmail-fixture-'));
  const ledger=new Ledger(root);t.after(()=>{ledger.close();fs.rmSync(root,{recursive:true,force:true});});
  const id=ledger.add('https://jobs.lever.co/fixture/role');
  ledger.update(id,'ready',{fingerprints:{cv:'fixture'},emailIntent:intent});
  ledger.set('stage','pilot');ledger.reserve(id,{limit:3,fingerprints:{cv:'fixture'}});
  ledger.update(id,'uncertain',{reasons:['Simulated crash after send']});
  return {root,ledger,id};
}
test('MIME includes one recipient, exact attachment bytes and durable message ID',()=>{
  const pdf=Buffer.from('%PDF-1.4 fixture attachment');
  const raw=applicationMime({...intent,subject:'Application: Research',body:'Primary-source text only',pdf}).toString();
  assert.ok(raw.includes(`To: ${intent.to}\r\n`));assert.ok(raw.includes(`Message-ID: ${intent.messageId}\r\n`));
  assert.ok(raw.includes(pdf.toString('base64')));assert.ok(!raw.includes('Bcc:'));
  assert.throws(()=>applicationMime({...intent,subject:'Hello\r\nBcc: bad@example.invalid',body:'',pdf}),/Invalid email subject/);
  assert.throws(()=>applicationMime({...intent,to:'one@example.invalid,two@example.invalid',subject:'Hello',body:'',pdf}),/exact sender/);
});
test('email draft rejects unverified recipients and unsupported candidate claims',()=>{
  const context={profile:{candidate:{full_name:'Example',email:intent.from}},sources:{'cv.md':'Approved fact','config/profile.yml':'Fixture'}};
  const job={sourceUrl:'https://employer.invalid/role',company:'Example',role:'Research',jd:'Apply for Research at jobs@employer.invalid'};
  const channel={verified:true,roleUrl:job.sourceUrl,sourceUrl:job.sourceUrl,employerHost:'employer.invalid',company:job.company,role:job.role,recipient:intent.to,quote:job.jd,postingHash:hash(job.jd)};
  assert.equal(emailDraft(context,job,channel).to,intent.to);
  assert.throws(()=>emailDraft(context,job,{...channel,verified:false}),/Verified/);
  assert.throws(()=>emailDraft(context,{...job,emailClaims:[{text:'Invented',quote:'Invented',source:'cv.md'}]},channel),/Unsupported/);
});
test('send entrypoint refuses failed rollout before any credential or network access',async t=>{
  const fixture=ledgerFixture(t);let contacted=false;const token=fixture.ledger.acquire();
  try {
    await assert.rejects(sendApplicationEmail({...fixture,context:{fingerprints:{}},accessProvider:async()=>{contacted=true;}}),/One complete/);
    assert.equal(contacted,false);assert.equal(fixture.ledger.status().attempts.length,1);
  } finally {fixture.ledger.release(token);}
});
test('uncertain email reconciles exact SENT metadata without sending again',async t=>{
  const fixture=ledgerFixture(t);const methods=[];
  const options={...fixture,accessProvider:async()=>({email:intent.from,token:'fixture'}),fetcher:async(url,opts)=>{
    methods.push(opts.method || 'GET');
    return {ok:true,json:async()=>url.includes('format=metadata')?{id:'gmail-fixture',internalDate:String(Date.parse('2026-10-09T12:00:00Z')),labelIds:['SENT'],payload:{headers:[{name:'From',value:intent.from},{name:'To',value:intent.to},{name:'Message-ID',value:intent.messageId}]}}:{messages:[{id:'gmail-fixture'}]}};
  }};
  const recovered=await reconcileEmail(options);
  assert.equal(recovered.confirmed,true);assert.equal(recovered.receipt.at,'2026-10-09T12:00:00.000Z');
  assert.equal(fixture.ledger.job(fixture.id).state,'confirmed');
  assert.equal((await reconcileEmail(options)).confirmed,true);
  assert.ok(methods.every(m=>m==='GET'));assert.equal(fixture.ledger.status().attempts.length,1);
});
test('reconciliation refuses a different provider message or missing timestamp',async t=>{
  const fixture=ledgerFixture(t);
  const headers=[{name:'From',value:intent.from},{name:'To',value:intent.to},{name:'Message-ID',value:intent.messageId}];
  for(const data of [{id:'wrong',internalDate:'1791547200000'},{id:'gmail-fixture'},{id:'gmail-fixture',internalDate:'NaN'}]) {
    const result=await reconcileEmail({...fixture,accessProvider:async()=>({email:intent.from,token:'fixture'}),fetcher:async url=>({ok:true,json:async()=>url.includes('format=metadata')?{...data,labelIds:['SENT'],payload:{headers}}:{messages:[{id:'gmail-fixture'}]}})});
    assert.equal(result.confirmed,false);assert.equal(fixture.ledger.job(fixture.id).state,'uncertain');
  }
});
test('missing and ambiguous email receipts stay uncertain and cannot be retried',async t=>{
  const fixture=ledgerFixture(t);
  for(const messages of [[],[{id:'a'},{id:'b'}]]){
    assert.equal((await reconcileEmail({...fixture,accessProvider:async()=>({email:intent.from,token:'fixture'}),fetcher:async()=>({ok:true,json:async()=>({messages})})})).confirmed,false);
    assert.equal(fixture.ledger.job(fixture.id).state,'uncertain');
    assert.throws(()=>fixture.ledger.retry(fixture.id),/Only/);
  }
});
