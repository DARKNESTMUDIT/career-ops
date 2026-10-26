import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Ledger} from '../autonomous/ledger.mjs';
import {captureInternshalaNativeSubmission} from '../autonomous/internshala-capture.mjs';
import {intentDigest,internshipIdentity} from '../autonomous/internshala-receipts.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
class NativePageFixture extends EventEmitter {
  constructor(url){super();this.source=url;this.handler=null;}
  url(){return this.source;}
  async route(pattern,fn){this.handler=fn;}
  async unroute(){this.handler=null;}
}
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-capture-')),ledger=new Ledger(root),token=ledger.acquire();
  const url='https://internshala.com/internship/detail/work-from-home-research-internship-at-example1792739586',id=ledger.add(url);
  const dir=path.join(ledger.dir,'bundles',id);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const pdf=Buffer.from('%PDF-1.4\nsynthetic fixture, never a real application\n%%EOF'),pdfPath=path.join(dir,'resume.pdf');fs.writeFileSync(pdfPath,pdf,{mode:0o600});
  const sourceHash=sha('synthetic approved primary');
  const intent={sourceUrl:url,state:'active',durableReference:'synthetic-attempt',reservedBeforeFirstPII:true,jobId:'12345',jobIdField:'internship_id',company:'Example',role:'Research Intern',approvedSources:['primary'],sourceProofs:{primary:{sha256:sourceHash}},fields:{answer:{value:'Synthetic approved answer',source:'primary',sourceSha256:sourceHash}},pdf:{fieldName:'custom_resume',filename:'resume.pdf',size:pdf.length,sha256:sha(pdf),frozenBeforeIntent:true}};
  const sealedIntentSha256=intentDigest(intent),intentFile=path.join(dir,'intent.json');fs.writeFileSync(intentFile,JSON.stringify(intent),{mode:0o600});
  // Synthetic test setup only. No rollout adapter flags or real credit.
  ledger.update(id,'submitting',{internshalaIntentSha256:sealedIntentSha256});ledger.db.prepare('INSERT INTO attempts VALUES (?,?,?,?,NULL)').run('synthetic-attempt',id,'2099-01-01','intent');
  const options={ledger,id,intentFile,sealedIntentSha256,pdfPath,proofDir:path.join(dir,'native-proof')},page=new NativePageFixture(url);
  t.after(()=>{ledger.release(token);ledger.close();fs.rmSync(root,{recursive:true,force:true});});
  function request({bodyPdf=pdf,endpoint=internshipIdentity(url).submitUrl,method='POST'}={}) {
    const boundary='fixture-boundary';
    const bytes=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="internship_id"\r\n\r\n12345\r\n--${boundary}\r\nContent-Disposition: form-data; name="answer"\r\n\r\nSynthetic approved answer\r\n--${boundary}\r\nContent-Disposition: form-data; name="custom_resume"; filename="resume.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),bodyPdf,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return {method:()=>method,url:()=>endpoint,postDataBuffer:()=>bytes,allHeaders:async()=>({'content-type':`multipart/form-data; boundary=${boundary}`})};
  }
  async function invoke(req,onContinue=()=>{}){const observed={continued:0,aborted:0};await page.handler({request:()=>req,continue:async()=>{onContinue();observed.continued++;},abort:async()=>{observed.aborted++;}});return observed;}
  return {ledger,id,dir,pdf,options,page,request,invoke};
}
test('recorder requires an existing locked intent and frozen PDF before installation',async t=>{
  const f=fixture(t);f.ledger.set('paused',true);await assert.rejects(captureInternshalaNativeSubmission(f.page,f.options),/Active locked/);f.ledger.set('paused',false);
  fs.writeFileSync(f.options.pdfPath,'%PDF-wrong');await assert.rejects(captureInternshalaNativeSubmission(f.page,f.options),/Frozen PDF/);assert.equal(f.page.handler,null);
});
test('native PDF/body proof is durable before the one original POST continues',async t=>{
  const f=fixture(t),capture=await captureInternshalaNativeSubmission(f.page,f.options),req=f.request();
  const result=await f.invoke(req,()=>{assert.ok(fs.existsSync(path.join(f.options.proofDir,'request.json')));assert.equal(f.ledger.db.prepare("SELECT count(*) n FROM events WHERE kind='internshala-native-request-observed'").get().n,1);});
  assert.equal(result.continued,1);assert.equal(result.aborted,0);
  const raw=Buffer.from('{"success":true,"providerField":"exact raw body"}');
  f.page.emit('response',{request:()=>req,body:async()=>raw,status:()=>200,url:()=>req.url()});
  const proof=await capture.stop();assert.equal(proof.continued,true);assert.equal(proof.receiptCertified,false);assert.equal(proof.har.log.entries[0].response.status,200);assert.equal(Buffer.from(proof.har.log.entries[0].response.content.text,'base64').toString(),raw.toString());
  assert.equal(f.ledger.job(f.id).state,'submitting');assert.equal(f.ledger.db.prepare('SELECT outcome FROM attempts WHERE job_id=?').get(f.id).outcome,'intent');
});
test('changed PDF bytes, wrong role and duplicate native POST are aborted',async t=>{
  const f=fixture(t),capture=await captureInternshalaNativeSubmission(f.page,f.options);
  assert.equal((await f.invoke(f.request({bodyPdf:Buffer.from('%PDF-stale')}))).aborted,1);
  assert.equal((await f.invoke(f.request({endpoint:'https://internshala.com/application/submit/different-role'}))).aborted,1);
  assert.equal((await f.invoke(f.request())).continued,1);assert.equal((await f.invoke(f.request())).aborted,1);
  const result=await capture.stop();assert.equal(result.receiptCertified,false);assert.equal(result.failures.length,3);
});
test('proof write failure aborts the native request instead of sending without durable proof',async t=>{
  const f=fixture(t),capture=await captureInternshalaNativeSubmission(f.page,f.options);fs.mkdirSync(path.join(f.options.proofDir,'request.json'));
  assert.equal((await f.invoke(f.request())).aborted,1);assert.equal((await capture.stop()).continued,false);
});
test('missing response stays unconfirmed and original evidence directory cannot be reused',async t=>{
  const f=fixture(t),capture=await captureInternshalaNativeSubmission(f.page,f.options);await f.invoke(f.request());const result=await capture.stop();
  assert.deepEqual(result.har.log.entries[0].response,{});assert.equal(result.receiptCertified,false);
  await assert.rejects(captureInternshalaNativeSubmission(f.page,f.options),/EEXIST/);
});
test('changed durable intent is refused before installing any route',async t=>{
  const f=fixture(t);const intent=JSON.parse(fs.readFileSync(f.options.intentFile));intent.fields.answer.value='Unapproved changed answer';fs.writeFileSync(f.options.intentFile,JSON.stringify(intent));await assert.rejects(captureInternshalaNativeSubmission(f.page,f.options),/Durable intent mismatch/);assert.equal(f.page.handler,null);
});
test('pause after installation aborts before native send',async t=>{
  const f=fixture(t),capture=await captureInternshalaNativeSubmission(f.page,f.options);f.ledger.set('paused',true);assert.equal((await f.invoke(f.request())).aborted,1);assert.equal((await capture.stop()).continued,false);
});
test('lost response body retains actual HTTP metadata and cannot establish acceptance',async t=>{
  const f=fixture(t),capture=await captureInternshalaNativeSubmission(f.page,f.options),req=f.request();await f.invoke(req);
  f.page.emit('response',{request:()=>req,body:async()=>{throw Error('Connection lost while reading body');},status:()=>200,url:()=>req.url()});
  const proof=await capture.stop();assert.equal(JSON.parse(fs.readFileSync(path.join(f.options.proofDir,'response-metadata.json'))).status,200);assert.equal(proof.receiptCertified,false);assert.deepEqual(proof.har.log.entries[0].response,{});assert.equal(proof.failures[0].where,'response');
  assert.equal((await f.invoke(f.request())).aborted,1);
});
