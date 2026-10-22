import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {leverJobIdentity,inspectLeverForm,captureFormEvidence,reconcileForm} from '../autonomous/form-receipts.mjs';
const url='https://jobs.lever.co/example/11111111-1111-4111-a111-111111111111/apply';
const form='<form id="application-form" method="post" enctype="multipart/form-data"><input name="h-captcha-response" type="hidden" value=""><button id="btn-submit" type="button">Submit application</button></form>';
test('Lever identity binds region, site and UUID; query never becomes receipt identity',()=>{
 assert.equal(leverJobIdentity(url+'?source=campaign').formUrl,url);
 for(const value of [url.replace('https:','http:'),url.replace('jobs.lever.co','jobs.lever.co.attacker.invalid'),url+'/thanks',url.replace('/example/','/example/nested/'),url.replace('https://','https://user:secret@'),url.replace('jobs.lever.co','jobs.lever.co:8443')])assert.equal(leverJobIdentity(value),null);
 assert.notEqual(leverJobIdentity(url).sourceUrl,leverJobIdentity(url.replace('jobs.lever.co','jobs.eu.lever.co')).sourceUrl);
});
test('real Chromium inspects hosted Lever form without mistaking it for API acceptance',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:form}));await page.goto(url);
 const contract=await inspectLeverForm(page,url);
 assert.equal(contract.receiptCertified,false);assert.equal(contract.captchaPresent,true);assert.equal(contract.captchaReady,false);
 await assert.rejects(inspectLeverForm(page,url.replace('/example/','/other/')),/identity/);
 await page.locator('form').evaluate(el=>el.action='https://attacker.invalid/collect');
 await assert.rejects(inspectLeverForm(page,url),/contract changed/);
});
test('public thank-you text records private evidence without becoming acceptance',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'form-receipt-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const page={url:()=>url,screenshot:async()=>Buffer.from('fake image fixture'),locator:()=>({innerText:async()=> 'Thank you for applying. Application received.'})};
 const evidence=await captureFormEvidence(page,{directory,jobId:'job-1',sourceUrl:url});
 assert.equal(evidence.accepted,false);assert.equal(evidence.jobId,'job-1');
 assert.equal(fs.statSync(evidence.evidencePath).mode & 0o777,0o600);
 assert.match(evidence.screenshot.sha256,/^[0-9a-f]{64}$/);
 await assert.rejects(captureFormEvidence({...page,url:()=>url.replace('/example/','/other/')},{directory,jobId:'job-1',sourceUrl:url}),/different posting/);
});
test('reconciliation uses fresh GET-only context and preserves uncertain outcome',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'form-reconcile-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let handler,closed=false,receiptCalls=0,events=[];
 const observation={url:()=>url,screenshot:async()=>Buffer.from('fixture'),locator:()=>({innerText:async()=> 'Thank you for applying'}),goto:async value=>assert.equal(value,url)};
 const fresh={route:async(_,callback)=>{handler=callback},newPage:async()=>observation,close:async()=>{closed=true}};
 const page={context:()=>({browser:()=>({newContext:async options=>{assert.equal(options.serviceWorkers,'block');return fresh}})})};
 const sourceUrl=leverJobIdentity(url).sourceUrl;
 const job={state:'uncertain',url,payload:{formIntent:{sourceUrl,attempt:'intent-1'}}};
 const ledger={job:()=>job,db:{prepare:()=>({get:()=>({id:'intent-1',outcome:'intent'})})},event:(...args)=>events.push(args),receipt:()=>receiptCalls++};
 const result=await reconcileForm({page,ledger,id:'job-1',directory});
 assert.equal(result.confirmed,false);assert.equal(receiptCalls,0);assert.equal(job.state,'uncertain');assert.equal(events.length,1);assert.equal(closed,true);
 const calls=[];for(const method of ['GET','HEAD','POST','PUT','DELETE'])await handler({request:()=>({method:()=>method}),continue:()=>calls.push(`${method}:continue`),abort:()=>calls.push(`${method}:abort`)});
 assert.deepEqual(calls,['GET:continue','HEAD:continue','POST:abort','PUT:abort','DELETE:abort']);
 job.payload.formIntent.attempt='other';await assert.rejects(reconcileForm({page,ledger,id:'job-1',directory}),/mismatched durable/);
});
