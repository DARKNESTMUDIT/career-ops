import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {Ledger} from '../autonomous/ledger.mjs';
import {sealBundle} from '../autonomous/bundle.mjs';
import {MICHMER,verifyMichmerResponse,reconcileMichmerForm,submitMichmer} from '../autonomous/michmer-form.mjs';
const moduleURL=new URL('../autonomous/michmer-form.mjs',import.meta.url);
// Original synthetic HTML implements the observed shape and response behavior.
// Only these in-memory test modules accept its script hash. Production remains
// pinned to the independently reviewed public employer script.
const html=fs.readFileSync(new URL('fixtures/michmer-careers.html',import.meta.url),'utf8');
const fixtureScript=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match=>match[1]).join('\n');
const fixtureHash=createHash('sha256').update(fixtureScript).digest('hex');
const syntheticSource=fs.readFileSync(moduleURL,'utf8').replace(MICHMER.scriptHash,fixtureHash);
const absoluteImports=source=>source.replace(/from '([^']+)'/g,(_,name)=>`from '${name.startsWith('.')?new URL(name,moduleURL).href:name}'`);
const fixtureModule=await import(`data:text/javascript;base64,${Buffer.from(absoluteImports(syntheticSource)).toString('base64')}`);
const {inspectMichmerForm,prepareMichmer,verifyMichmerPrepared,fetchMichmerPosting}=fixtureModule;
// Transport-only tests isolate the authorization gate; a separate test below
// exercises actual rollout, bundle validation and the real ledger lock.
const isolatedSource=absoluteImports(syntheticSource.replace("import { authorizeSubmission } from './rollout.mjs';","function authorizeSubmission(ledger) { if(ledger.job().state!=='ready')throw new Error('Not ready or duplicate attempt'); return {limit:1}; }"));
const transport=await import(`data:text/javascript;base64,${Buffer.from(isolatedSource).toString('base64')}`);
const profile={candidate:{full_name:'Fixture Candidate',email:'candidate@example.invalid'},location:{city:'New Delhi'}};
async function fixture(t) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'michmer-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const resumePath=path.join(directory,'resume.pdf');fs.writeFileSync(resumePath,'%PDF-1.4\nSynthetic fixture resume only.');
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();await page.route('**/*',route=>route.request().url()===MICHMER.page?route.fulfill({contentType:'text/html',body:html}):route.abort());
 await page.goto(MICHMER.page);const prepared=await prepareMichmer(page,profile,resumePath,{url:MICHMER.page,payload:{role:MICHMER.roleLabel}});
 fs.writeFileSync(path.join(directory,'answers.json'),JSON.stringify(prepared,null,2));
 const job={url:MICHMER.page,state:'ready',payload:{role:MICHMER.roleLabel,bundle:directory,fingerprints:{fixture:true}}};let attempt;
 const ledger={job:()=>job,get:()=>false,event:()=>{},reserve:()=>{if(attempt)throw new Error('Never retry existing intent');attempt={id:'attempt-fixture',outcome:'intent'};return attempt.id;},update:(_,state,payload)=>{job.state=state;Object.assign(job.payload,payload)},receipt:(_,receipt)=>{attempt.receipt=receipt;attempt.outcome='confirmed';job.state='confirmed';},db:{prepare:()=>({get:()=>attempt})}};
 return {page,prepared,ledger,resumePath,bundle:directory,id:'job-fixture',context:{fingerprints:job.payload.fingerprints},job};
}
async function network(f,{status=200,body='{"ok":true}',lost=false}={}) {
 const originalRoute=f.page.route.bind(f.page), originalUnroute=f.page.unroute.bind(f.page), wrappers=new Map();let posts=0;
 f.page.route=async(pattern,handler)=>{const wrapper=route=>{return handler({request:()=>route.request(),abort:reason=>route.abort(reason),continue:()=>{posts++;assert.equal(f.job.state,'submitting');assert.equal(f.job.payload.formIntent.attempt,'attempt-fixture');return lost?route.abort('connectionreset'):route.fulfill({status,contentType:'application/json',body});}})};wrappers.set(handler,wrapper);return originalRoute(pattern,wrapper)};
 f.page.unroute=(pattern,handler)=>originalUnroute(pattern,wrappers.get(handler));
 {const wait=f.page.waitForResponse.bind(f.page);f.page.waitForResponse=(pred,opts)=>wait(pred,{...opts,timeout:5000});}
 return ()=>posts;
}
test('synthetic form fills explicit primary city and exact PDF; changed mandatory fields fail closed',async t=>{
 const f=await fixture(t);assert.equal(f.prepared.values.city,'Other');assert.equal(f.prepared.values.cityOther,'New Delhi');assert.equal(f.prepared.sources.city,'config/profile.yml#location.city');assert.deepEqual(f.prepared.issues,[]);assert.equal(f.prepared.answers.find(a=>a.type==='file').fileHash,f.prepared.resumeHash);
 await f.page.locator('#name').fill('Changed');await assert.rejects(verifyMichmerPrepared(f.page,f.prepared,f.resumePath),/answer changed/);
 await f.page.locator('#applyForm').evaluate(el=>el.insertAdjacentHTML('beforeend','<input required id="unknown">'));await assert.rejects(inspectMichmerForm(f.page),/fields or role changed/);
});
test('exact role capture rejects other hash, leaves other roles out, and never fabricates India',async()=>{
 let gets=0;const fetcher=async(_,opts)=>{gets++;assert.equal(opts.method,'GET');return new Response(html)};
 const posting=await fetchMichmerPosting(MICHMER.page,fetcher);assert.match(posting.text,/Product Management Intern/);assert.doesNotMatch(posting.text,/Software Development Intern/);assert.equal(posting.sourceUrl,MICHMER.source);assert.equal(await fetchMichmerPosting(MICHMER.page+'#software-development',fetcher),null);assert.equal(gets,1);
});
test('production rollout denies before any form click without authorization',async()=>{
 let touches=0;await assert.rejects(submitMichmer({locator:()=>{touches++;throw Error('Unexpected page access')}},{ledger:{ownsLock:()=>false,job:()=>({url:MICHMER.page}),jobs:()=>[],db:{prepare:()=>({all:()=>[]})},get:()=>null},id:'x',context:{fingerprints:{}}}),/validation pending|active runner lock/);assert.equal(touches,0);
});
test('single native click requires exact request bytes and observed accepted response; unique receipt survives replay',async t=>{
 const f=await fixture(t),posts=await network(f);const receipt=await transport.submitMichmer(f.page,f);
 assert.equal(posts(),1);assert.equal(f.job.state,'confirmed');assert.match(receipt.reference,/^michmer:attempt-fixture:/);assert.ok(fs.existsSync(receipt.screenshot));
 const replay=await reconcileMichmerForm({ledger:f.ledger,id:f.id});assert.equal(replay.confirmed,true);assert.equal(replay.receipt.reference,receipt.reference);
 await assert.rejects(transport.submitMichmer(f.page,f),/duplicate/);assert.equal(posts(),1);
 fs.appendFileSync(path.join(f.bundle,'michmer-response.txt'),'changed');await assert.rejects(reconcileMichmerForm({ledger:f.ledger,id:f.id}),/integrity mismatch/);
});
test('employer rejection produces uncertain durable intent and never resends',async t=>{
 const f=await fixture(t),posts=await network(f,{status:400,body:'{"error":"Rejected"}'});await assert.rejects(transport.submitMichmer(f.page,f),/no verified accepted/);assert.equal(posts(),1);assert.equal(f.job.state,'uncertain');await assert.rejects(transport.submitMichmer(f.page,f),/duplicate/);assert.equal(posts(),1);assert.equal((await reconcileMichmerForm({ledger:f.ledger,id:f.id})).confirmed,false);
});
test('lost response remains uncertain and no public GET or retry invents acceptance',async t=>{
 const f=await fixture(t),posts=await network(f,{lost:true});await assert.rejects(transport.submitMichmer(f.page,f),/Timeout/);assert.equal(posts(),1);assert.equal(f.job.state,'uncertain');assert.equal((await reconcileMichmerForm({ledger:f.ledger,id:f.id})).confirmed,false);await assert.rejects(transport.submitMichmer(f.page,f),/duplicate/);assert.equal(posts(),1);
});
test('acceptance parser rejects redirect, HTML, malformed JSON and explicit rejection',()=>{
 for(const [status,body,contentType] of [[302,'{}','application/json'],[200,'ok','text/html'],[200,'broken','application/json'],[200,'{"error":"Bad"}','application/json'],[200,'{"success":false}','application/json']])assert.throws(()=>verifyMichmerResponse({url:MICHMER.endpoint,status,body,contentType}));
 assert.equal(verifyMichmerResponse({url:MICHMER.endpoint,status:200,body:'{"ok":true}',contentType:'application/json'}).status,200);
});

test('actual rollout, bundle and ledger lock authorize exactly one isolated adapter transport',async t=>{
 const rolloutURL=new URL('../autonomous/rollout.mjs',import.meta.url);
 let gateSource=fs.readFileSync(rolloutURL,'utf8');
 gateSource=gateSource.includes('michmer:false')?gateSource.replace('michmer:false','michmer:true'):gateSource.includes('michmer:true')?gateSource:gateSource.replace('gmail:true','gmail:true,michmer:true');
 gateSource=gateSource.replace(/from '([^']+)'/g,(_,name)=>`from '${name.startsWith('.')?new URL(name,rolloutURL).href:name}'`);
 const gateModule=`data:text/javascript;base64,${Buffer.from(gateSource).toString('base64')}`;
 const source=syntheticSource.replace("from './rollout.mjs'",`from '${gateModule}'`).replace(/from '([^']+)'/g,(_,name)=>`from '${name.startsWith('.')?new URL(name,moduleURL).href:name}'`);
 const realTransport=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
 const f=await fixture(t), ledger=new Ledger(f.bundle);let token;t.after(()=>{if(token)ledger.release(token);ledger.close();});
 const id=ledger.add(MICHMER.page),fingerprints={fixture:true};
 const payload={role:MICHMER.roleLabel,bundle:f.bundle,fingerprints,track:'remote',start:'2099-01-01',deadline:'2098-12-31',dryRunComplete:true};
 for(const file of ['jd.txt','resume.html','claims.json','decision.json'])fs.writeFileSync(path.join(f.bundle,file),'Synthetic gate fixture only');
 sealBundle(f.bundle,{...payload,sourceUrl:MICHMER.source},f.prepared);
 ledger.update(id,'ready',payload);f.ledger=ledger;f.id=id;f.context={fingerprints};Object.defineProperty(f,'job',{get:()=>ledger.job(id)});
 await assert.rejects(realTransport.submitMichmer(f.page,f),/active runner lock/);
 token=ledger.acquire();
 const originalRoute=f.page.route.bind(f.page), originalUnroute=f.page.unroute.bind(f.page), wrappers=new Map();let posts=0;
 f.page.route=async(pattern,handler)=>{const wrapper=route=>handler({request:()=>route.request(),abort:reason=>route.abort(reason),continue:()=>{posts++;assert.equal(ledger.job(id).state,'submitting');assert.equal(ledger.status().attempts.length,1);return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});}});wrappers.set(handler,wrapper);return originalRoute(pattern,wrapper)};
 f.page.unroute=(pattern,handler)=>originalUnroute(pattern,wrappers.get(handler));
 const receipt=await realTransport.submitMichmer(f.page,f);assert.equal(posts,1);assert.equal(ledger.job(id).state,'confirmed');assert.equal(ledger.status().attempts[0].outcome,'confirmed');
 assert.equal((await reconcileMichmerForm({ledger,id})).receipt.reference,receipt.reference);
 await assert.rejects(realTransport.submitMichmer(f.page,f));assert.equal(posts,1);
});
