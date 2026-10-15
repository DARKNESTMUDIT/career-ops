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

function rewrittenFixture(t){
  const fixture=ledgerFixture(t),bundle=path.join(fixture.root,'bundle');fs.mkdirSync(bundle);
  const subject='Application: Research',body='Synthetic candidate application.\nOnly primary-source facts.',pdf=Buffer.from('%PDF-1.4 synthetic bytes');
  const createdAt='2026-10-09T12:00:00.000Z',file=path.join(bundle,'application.eml');
  const raw=applicationMime({...intent,subject,body,pdf,date:new Date(createdAt)});fs.writeFileSync(file,raw);
  const durable={...intent,subject,createdAt,file,rawHash:hash(raw.toString('base64')),bodyHash:hash(body),pdfHash:hash(pdf.toString('base64'))};
  fixture.ledger.update(fixture.id,'uncertain',{bundle,emailIntent:durable});
  const message=(id='rewritten-provider-id')=>({id,internalDate:String(Date.parse(createdAt)+1000),labelIds:['SENT'],payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:intent.from},{name:'To',value:intent.to},{name:'Message-ID',value:'<rewritten@mail.gmail.invalid>'},{name:'Subject',value:`=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`}],parts:[{mimeType:'text/plain',filename:'',body:{data:Buffer.from(body).toString('base64url')}},{mimeType:'application/pdf',filename:'resume.pdf',body:{attachmentId:'synthetic-attachment'}}]}});
  return {...fixture,durable,body,pdf,message,accessProvider:async()=>({email:intent.from,token:'fixture-token'})};
}
function rewrittenTransport(f,{messages=[f.message()],change,attachment=f.pdf,paginated=false}={}){
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,method:options.method||'GET'});assert.equal(options.method,undefined);
    const parsed=new URL(url),query=parsed.searchParams.get('q');
    let result;
    if(query?.includes('rfc822msgid:'))result={messages:[]};
    else if(query){assert.equal(parsed.searchParams.get('maxResults'),'10');assert.ok(query.includes('in:sent'));assert.ok(query.includes('after:'));assert.ok(query.includes('before:'));result={messages:messages.map(m=>({id:m.id})),...(paginated?{nextPageToken:'more'}:{})};}
    else if(parsed.pathname.includes('/attachments/'))result={data:attachment.toString('base64url')};
    else {const id=parsed.pathname.split('/').at(-1);result=structuredClone(messages.find(m=>m.id===id));if(change)change(result);}
    return {ok:true,json:async()=>result};
  };
  return {fetcher,calls};
}
test('known accepted Gmail ID reconciles rewritten Message-ID directly and preserves Applied and durable receipt',async t=>{
  const f=rewrittenFixture(t),accepted={kind:'gmail-accepted',reference:'rewritten-provider-id',messageId:intent.messageId,at:'2026-10-09T12:00:01.000Z'};
  f.ledger.receipt(f.id,accepted);f.ledger.update(f.id,'applied',{trackerSync:{verified:true,row:1}});
  const before=f.ledger.status().attempts,transport=rewrittenTransport(f);
  const result=await reconcileEmail({...f,...transport});
  assert.equal(result.confirmed,true);assert.equal(result.receipt.providerMessageId,'<rewritten@mail.gmail.invalid>');assert.equal(result.receipt.messageId,intent.messageId);
  assert.equal(transport.calls.length,1);assert.ok(!transport.calls[0].url.includes('/messages?'));assert.ok(transport.calls.every(c=>c.method==='GET'));
  assert.equal(f.ledger.job(f.id).state,'applied');assert.deepEqual(f.ledger.status().attempts,before);
});
test('unknown rewritten Gmail ID recovers only a unique exact body and PDF match through bounded GETs',async t=>{
  const f=rewrittenFixture(t),transport=rewrittenTransport(f);
  const result=await reconcileEmail({...f,...transport});
  assert.equal(result.confirmed,true);assert.equal(result.receipt.reference,'rewritten-provider-id');assert.equal(result.receipt.providerMessageId,'<rewritten@mail.gmail.invalid>');
  assert.equal(result.receipt.at,'2026-10-09T12:00:01.000Z');assert.equal(f.ledger.job(f.id).state,'confirmed');
  assert.equal(transport.calls.length,4);assert.ok(transport.calls.every(c=>c.method==='GET'));assert.equal(f.ledger.status().attempts.length,1);
});
test('rewritten recovery refuses wrong body, wrong PDF, duplicate candidate and pagination without sending',async t=>{
  for(const variation of ['body','pdf','ambiguous','pagination']){
    const f=rewrittenFixture(t);
    const transport=rewrittenTransport(f,{...(variation==='body'?{change:m=>{m.payload.parts[0].body.data=Buffer.from('Wrong body').toString('base64url');}}:{}),...(variation==='pdf'?{attachment:Buffer.from('%PDF-1.4 wrong attachment')}:{}),...(variation==='ambiguous'?{messages:[f.message(),f.message('second-provider-id')]}:{}),paginated:variation==='pagination'});
    assert.equal((await reconcileEmail({...f,...transport})).confirmed,false,variation);
    assert.equal(f.ledger.job(f.id).state,'uncertain');assert.equal(f.ledger.status().attempts[0].outcome,'intent');assert.ok(transport.calls.every(c=>c.method==='GET'));
  }
});
test('rewritten recovery refuses altered immutable evidence and legacy intent before fallback search',async t=>{
  for(const variation of ['raw','legacy','path','createdAt']){
    const f=rewrittenFixture(t);
    if(variation==='raw')fs.appendFileSync(f.durable.file,'tamper');
    if(variation==='legacy')f.ledger.update(f.id,'uncertain',{emailIntent:intent});
    if(variation==='path')f.ledger.update(f.id,'uncertain',{emailIntent:{...f.durable,file:path.join(f.root,'unrelated.eml')}});
    if(variation==='createdAt')f.ledger.update(f.id,'uncertain',{emailIntent:{...f.durable,createdAt:'2026-02-30T12:00:00.000Z'}});
    const transport=rewrittenTransport(f);
    assert.equal((await reconcileEmail({...f,...transport})).confirmed,false,variation);assert.equal(transport.calls.length,1);
    assert.equal(f.ledger.job(f.id).state,'uncertain');
  }
});
test('rewritten recovery rejects header duplication, invalid time, wrong labels/subject, malformed base64 and excess MIME parts',async t=>{
  const changes=[m=>m.payload.headers.push({name:'From',value:intent.from}),m=>m.payload.headers.push({name:'Subject',value:'Application: Research'}),m=>{m.internalDate=String(Date.parse('2026-10-09T12:20:01Z'));},m=>{m.labelIds=[];},m=>{m.payload.headers.find(h=>h.name==='Subject').value='Different role';},m=>{m.payload.parts[0].body.data='%%%';},m=>{m.payload.parts.push(m.payload.parts[0]);},m=>{m.payload.headers.find(h=>h.name==='Message-ID').value='<invalid\r\nheader>';},m=>{m.payload.headers.find(h=>h.name==='Subject').value='=?UTF-8?B?////?=';}];
  for(const change of changes){
    const f=rewrittenFixture(t),transport=rewrittenTransport(f,{change});
    assert.equal((await reconcileEmail({...f,...transport})).confirmed,false);assert.equal(f.ledger.job(f.id).state,'uncertain');assert.ok(transport.calls.every(c=>c.method==='GET'));
  }
});
