import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Ledger} from '../autonomous/ledger.mjs';
import {run,loadContext} from '../autonomous/runner.mjs';
import {verifyBundle} from '../autonomous/bundle.mjs';
import {hash} from '../autonomous/policy.mjs';
import {ADAPTER_VALIDATION,integrityPause} from '../autonomous/rollout.mjs';
import {syncReceipt} from '../autonomous/tracker.mjs';
import {resolveIntegrityPause} from '../autonomous/recovery.mjs';

// Certification uses real authorization, bundle, ledger and canonical writers.
// Only this in-memory gate differs; no production adapter is enabled. Both
// default credential and network paths fail closed in the cloned transport.
const rolloutFile=new URL('../autonomous/rollout.mjs',import.meta.url);
const gmailFile=new URL('../autonomous/gmail.mjs',import.meta.url);
const absoluteImports=(source,file)=>source.replace(/from '(\.\.?\/[^']+)'/g,(_,relative)=>`from '${new URL(relative,file).href}'`);
const dataModule=source=>`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const productionRollout=fs.readFileSync(rolloutFile,'utf8');
assert.equal(productionRollout.match(/gmail:(?:false|true)/g)?.length,1);
const productionAdapters={...ADAPTER_VALIDATION};
const assertProductionAdapters=()=>{assert.deepEqual(ADAPTER_VALIDATION,productionAdapters);for(const adapter of ['greenhouse','lever','ashby'])assert.equal(ADAPTER_VALIDATION[adapter],false);};
const rolloutURL=dataModule(absoluteImports(productionRollout.replace(/gmail:(?:false|true)/,'gmail:true'),rolloutFile));
const certified=await import(rolloutURL);
let gmailSource=fs.readFileSync(gmailFile,'utf8');
assert.ok(gmailSource.includes("import { authorizeSubmission } from './rollout.mjs';"));
gmailSource=gmailSource.replace("import { authorizeSubmission } from './rollout.mjs';",`import { authorizeSubmission } from '${rolloutURL}';`)
  .replace("import { gmailAccess } from './gmail-auth.mjs';","const gmailAccess=()=>{throw new Error('Fixture credentials forbidden');};")
  .replaceAll('fetcher=fetch',"fetcher=()=>{throw new Error('Fixture network forbidden');}");
const gmail=await import(dataModule(absoluteImports(gmailSource,gmailFile)));
// A private module supplies test-only external boundaries to the unchanged
// send call made by submitReady. Unconfigured defaults remain fail-closed.
const boundaryURL=dataModule(`export const fixtureBoundary={};
export function fixtureFetch(...args){if(!fixtureBoundary.fetcher)throw new Error('Fixture network forbidden');return fixtureBoundary.fetcher(...args);}
export function fixtureAccess(...args){if(!fixtureBoundary.accessProvider)throw new Error('Fixture credentials forbidden');return fixtureBoundary.accessProvider(...args);}`);
const {fixtureBoundary}=await import(boundaryURL);
const orchestrationGmailSource=gmailSource
  .replace("const gmailAccess=()=>{throw new Error('Fixture credentials forbidden');};",`import {fixtureFetch,fixtureAccess as gmailAccess} from '${boundaryURL}';`)
  .replaceAll("fetcher=()=>{throw new Error('Fixture network forbidden');}",'fetcher=fixtureFetch');
const orchestrationGmailURL=dataModule(absoluteImports(orchestrationGmailSource,gmailFile));
const runnerFile=new URL('../autonomous/runner.mjs',import.meta.url);
const runnerSource=fs.readFileSync(runnerFile,'utf8')
  .replace("from 'js-yaml'",`from '${import.meta.resolve('js-yaml')}'`)
  .replace("from './gmail.mjs'",`from '${orchestrationGmailURL}'`)
  .replace("from './rollout.mjs'",`from '${rolloutURL}'`)
  .replaceAll('import.meta.url',JSON.stringify(runnerFile.href));
const orchestration=await import(dataModule(absoluteImports(runnerSource,runnerFile)));


async function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gmail-integration-')));
  const saved=Object.fromEntries(['CAREER_OPS_ROOT','CAREER_OPS_DATA_DIR','CAREER_OPS_TRACKER'].map(k=>[k,process.env[k]]));
  process.env.CAREER_OPS_ROOT=root;delete process.env.CAREER_OPS_DATA_DIR;
  process.env.CAREER_OPS_TRACKER=path.join(root,'data/applications.md');
  let ledger,token;
  t.after(()=>{if(token)ledger.release(token);ledger?.close();for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});});
  for(const dir of ['config','modes','data'])fs.mkdirSync(path.join(root,dir));
  fs.writeFileSync(path.join(root,'cv.md'),'# Synthetic Candidate\n\n## Experience\n- Product research and AI prompt experiments\n');
  fs.writeFileSync(path.join(root,'config/profile.yml'),JSON.stringify({candidate:{full_name:'Synthetic Candidate',email:'candidate@employer.invalid'},availability:{remote:{earliest_start:'2027-01-01',latest_end:'2027-06-30',max_months:6,max_hours_per_week:40},summer:{earliest_start:'2027-07-01',latest_end:'2027-08-31',max_months:2,max_hours_per_week:40}}}));
  for(const name of ['_profile','_custom'])fs.writeFileSync(path.join(root,`modes/${name}.md`),'Synthetic fixture only');
  ledger=new Ledger(root);
  const channels={},postings=new Map(),jobs=[];
  for(let i=0;i<5;i++) {
    const url=`https://employer.invalid/internship/${i}`,track=i%2?'summer':'remote';
    const jd='Synthetic Employer invites students in India to apply for a paid fully remote product research internship. Work 40 hours weekly from 2027-01-01 to 2027-06-30, or summer from 2027-07-01 to 2027-08-31. Deadline 2026-12-01. Research users and AI applications. Apply for this role by emailing jobs@employer.invalid.';
    const job={company:`Synthetic Employer ${i}`,role:'Product research intern',track,start:track==='remote'?'2027-01-01':'2027-07-01',end:track==='remote'?'2027-06-30':'2027-08-31',deadline:'2026-12-01',hours:40,indiaEligible:true,studentEligible:true,remote:true,country:'India',duties:'substantive',pay:'paid',fit:4.5,evidence:{}};
    for(const k of Object.keys(job))job.evidence[k]=jd;
    const id=ledger.add(url);postings.set(url,jd);jobs.push({id,url,job});
    channels[url]={verified:true,roleUrl:url,sourceUrl:url,employerHost:'employer.invalid',company:job.company,role:job.role,recipient:'jobs@employer.invalid',quote:'Apply for this role by emailing jobs@employer.invalid.',postingHash:hash(jd)};
  }
  fs.writeFileSync(path.join(root,'data/autonomous/email-channels.json'),JSON.stringify(channels));
  let captured;
  const result=await run({root,fetchJD:async url=>{captured=jobs.find(j=>j.url===url);return {text:postings.get(url)};},evaluate:async()=>captured.job,prepare:async()=>{throw new Error('Email fixture must not open browser');}});
  assert.equal(result.complete,5);assert.equal(result.rollout.stage,'pilot');
  assert.deepEqual(result.rollout.tracks.sort(),['remote','summer']);
  assert.ok(ledger.jobs().every(j=>j.payload.applicationKind==='email'&&verifyBundle(j.payload.bundle,j.payload.fingerprints)));
  const context=loadContext(root);token=ledger.acquire();
  const id=ledger.jobs()[0].id,channel=channels[ledger.job(id).url];
  return {root,ledger,id,channel,context,accessProvider:async()=>({email:context.profile.candidate.email,token:'synthetic-token'}),unlock:()=>{ledger.release(token);token=null;},lock:()=>{token=ledger.acquire();}};
}

test('real Gmail authorization sends once, canonical TSV/status synchronization and replay preserve one application',async t=>{
  assertProductionAdapters();
  assert.deepEqual(certified.ADAPTER_VALIDATION,{greenhouse:false,lever:false,ashby:false,gmail:true});
  const f=await fixture(t);let posts=0;
  const receipt=await gmail.sendApplicationEmail({...f,fetcher:async(url,options)=>{
    posts++;assert.equal(options.method,'POST');assert.ok(url.endsWith('/messages/send'));
    assert.equal(f.ledger.job(f.id).state,'submitting');assert.equal(f.ledger.status().attempts[0].outcome,'intent');
    const intent=f.ledger.job(f.id).payload.emailIntent,raw=fs.readFileSync(intent.file);
    assert.equal(hash(raw.toString('base64')),intent.rawHash);assert.deepEqual(Buffer.from(JSON.parse(options.body).raw,'base64url'),raw);
    return {ok:true,json:async()=>({id:'synthetic-accepted'})};
  }});
  assert.equal(receipt.reference,'synthetic-accepted');assert.equal(posts,1);
  const sync=await syncReceipt(f.root,f.ledger,f.id);
  assert.equal(sync.path,process.env.CAREER_OPS_TRACKER);assert.equal(f.ledger.job(f.id).state,'applied');
  const before=fs.readFileSync(sync.path,'utf8'),log=fs.readFileSync(path.join(f.root,'data/status-log.tsv'),'utf8');
  assert.match(before,/Applied/);assert.match(before,/receipt gmail-accepted: synthetic-accepted/);assert.match(log,/Evaluated\tApplied/);
  assert.equal((await syncReceipt(f.root,f.ledger,f.id)).row,sync.row);
  assert.equal(fs.readFileSync(sync.path,'utf8'),before);assert.equal(fs.readFileSync(path.join(f.root,'data/status-log.tsv'),'utf8'),log);
  await assert.rejects(gmail.sendApplicationEmail({...f,fetcher:async()=>{posts++;throw new Error('Must not resend');}}),/Incomplete or changed bundle/);
  assert.equal(posts,1);assert.equal(f.ledger.status().attempts.length,1);
  assert.equal(certified.rolloutStatus(f.ledger,f.context.fingerprints).verifiedApplications,1);
});

test('lost response reconciles using GET, canonical synchronization and integrity recovery preserve durable attempt',async t=>{
  const f=await fixture(t);let posts=0,gets=0;
  await assert.rejects(gmail.sendApplicationEmail({...f,fetcher:async()=>{posts++;throw new Error('Synthetic lost response');}}),/lost response/);
  const original=f.ledger.status().attempts[0];assert.equal(f.ledger.job(f.id).state,'uncertain');
  integrityPause(f.ledger,'Synthetic uncertain send');
  await assert.rejects(resolveIntegrityPause(f.root,f.ledger),/Unresolved/);
  const intent=f.ledger.job(f.id).payload.emailIntent;
  const recovered=await gmail.reconcileEmail({...f,fetcher:async(url,options)=>{
    gets++;assert.equal(options.method,undefined);
    return {ok:true,json:async()=>url.includes('format=metadata')?{id:'synthetic-recovered',internalDate:'1791547200000',labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:intent.messageId},{name:'From',value:intent.from},{name:'To',value:intent.to}]}}:{messages:[{id:'synthetic-recovered'}]}};
  }});
  assert.equal(recovered.confirmed,true);assert.equal(posts,1);assert.equal(gets,2);
  await syncReceipt(f.root,f.ledger,f.id);
  const attempts=f.ledger.status().attempts;
  assert.equal(attempts[0].id,original.id);assert.equal(attempts[0].day,original.day);assert.equal(attempts.length,1);
  const tracker=process.env.CAREER_OPS_TRACKER,valid=fs.readFileSync(tracker,'utf8');
  fs.writeFileSync(tracker,valid.replace('receipt gmail-accepted: synthetic-recovered','receipt gmail-accepted: synthetic-recovered-drift'));
  await assert.rejects(resolveIntegrityPause(f.root,f.ledger),/reference drift/);
  assert.equal(f.ledger.get('paused'),true);assert.deepEqual(f.ledger.status().attempts,attempts);
  fs.writeFileSync(tracker,valid);
  assert.deepEqual(await resolveIntegrityPause(f.root,f.ledger),{resolved:true,verifiedApplications:1,tracker:process.env.CAREER_OPS_TRACKER});
  assert.deepEqual(f.ledger.status().attempts,attempts);assert.equal(f.ledger.get('paused'),false);
  assert.match(fs.readFileSync(process.env.CAREER_OPS_TRACKER,'utf8'),/2026-10-09/);
});

test('real gate refuses missing lock, source drift, bundle drift, absent credentials and exhausted pilot quota before network',async t=>{
  const f=await fixture(t);let posts=0;const fetcher=async()=>{posts++;return {ok:true,json:async()=>({id:`synthetic-${posts}`})};};
  f.unlock();await assert.rejects(gmail.sendApplicationEmail({...f,fetcher}),/active runner lock/);f.lock();
  fs.appendFileSync(path.join(f.root,'cv.md'),'\nSynthetic changed source');
  await assert.rejects(gmail.sendApplicationEmail({...f,context:loadContext(f.root),fetcher}),/One complete/);
  fs.writeFileSync(path.join(f.root,'cv.md'),'# Synthetic Candidate\n\n## Experience\n- Product research and AI prompt experiments\n');
  const pdf=path.join(f.ledger.job(f.id).payload.bundle,'resume.pdf'),bytes=fs.readFileSync(pdf);
  fs.appendFileSync(pdf,'changed');await assert.rejects(gmail.sendApplicationEmail({...f,fetcher}),/One complete|changed bundle/);fs.writeFileSync(pdf,bytes);
  await assert.rejects(gmail.sendApplicationEmail({...f,accessProvider:undefined,fetcher}),/credentials forbidden/);
  assert.equal(posts,0);assert.equal(f.ledger.status().attempts.length,0);
  for(const job of f.ledger.jobs().slice(0,3)) {
    await gmail.sendApplicationEmail({...f,id:job.id,channel:JSON.parse(fs.readFileSync(path.join(f.root,'data/autonomous/email-channels.json'),'utf8'))[job.url],fetcher});
    // Keep receipts confirmed rather than tracker-verified to prove pilot cap.
  }
  const next=f.ledger.jobs().find(j=>j.state==='ready');
  await assert.rejects(gmail.sendApplicationEmail({...f,id:next.id,channel:JSON.parse(fs.readFileSync(path.join(f.root,'data/autonomous/email-channels.json'),'utf8'))[next.url],fetcher}),/Pilot receipts/);
  assert.equal(posts,3);assert.equal(f.ledger.status().attempts.length,3);
  for(const job of f.ledger.jobs().filter(j=>j.state==='confirmed'))await syncReceipt(f.root,f.ledger,job.id);
  assert.equal(certified.rolloutStatus(f.ledger,f.context.fingerprints).stage,'initial');
  for(const job of f.ledger.jobs().filter(j=>j.state==='ready')){
    const channel=JSON.parse(fs.readFileSync(path.join(f.root,'data/autonomous/email-channels.json'),'utf8'))[job.url];
    await gmail.sendApplicationEmail({...f,id:job.id,channel,fetcher});await syncReceipt(f.root,f.ledger,job.id);
  }
  await assert.rejects(gmail.sendApplicationEmail({...f,fetcher}),/Daily submission limit/);
  assert.equal(posts,5);assert.equal(f.ledger.status().attempts.length,5);
});


test('real live runner orchestration submits only selected email ID, synchronizes receipt and never repeats it',async t=>{
  const f=await fixture(t);f.unlock();let posts=0,captures=0;
  const selected=f.ledger.job(f.id),others=f.ledger.jobs().filter(j=>j.id!==f.id).map(j=>j.id);
  fixtureBoundary.accessProvider=f.accessProvider;
  fixtureBoundary.fetcher=async(url,options)=>{
    posts++;assert.equal(options.method,'POST');assert.ok(url.endsWith('/messages/send'));
    assert.equal(f.ledger.job(f.id).state,'submitting');
    assert.ok(others.every(id=>f.ledger.job(id).state==='ready'));
    return {ok:true,json:async()=>({id:'synthetic-orchestrated'})};
  };
  t.after(()=>{delete fixtureBoundary.fetcher;delete fixtureBoundary.accessProvider;});
  const options={root:f.root,dryRun:false,jobIds:[f.id],fetchJD:async url=>{
    captures++;assert.equal(url,selected.url);return {text:selected.payload.jd};
  },evaluate:async()=>{throw new Error('Live send must not evaluate');},prepare:async()=>{throw new Error('Email must not open browser');}};
  const first=await orchestration.run(options);
  assert.equal(first.submitted,1);assert.deepEqual(first.tracker,{synced:1,failed:0});
  assert.equal(posts,1);assert.equal(captures,1);assert.equal(f.ledger.job(f.id).state,'applied');
  assert.ok(others.every(id=>f.ledger.job(id).state==='ready'));
  const tracker=fs.readFileSync(process.env.CAREER_OPS_TRACKER,'utf8');
  assert.match(tracker,/receipt gmail-accepted: synthetic-orchestrated/);
  const second=await orchestration.run(options);
  assert.equal(second.submitted,0);assert.equal(posts,1);assert.equal(captures,1);
  assert.equal(f.ledger.status().attempts.length,1);
  assert.equal(fs.readFileSync(process.env.CAREER_OPS_TRACKER,'utf8'),tracker);
  assert.ok(others.every(id=>f.ledger.job(id).state==='ready'));
  assertProductionAdapters();
  assert.equal(fs.readFileSync(rolloutFile,'utf8'),productionRollout);
});


test('real authorization requires a current bundle and rejects individual stale jobs without a batch prerequisite',async t=>{
  const f=await fixture(t),original=f.ledger.job(f.id),authorize=()=>certified.authorizeSubmission(f.ledger,f.id,f.context.fingerprints,'gmail');
  assert.equal(authorize().stage,'pilot');
  f.ledger.update(f.id,'exception',{});assert.throws(authorize,/Incomplete or changed bundle/);f.ledger.update(f.id,'ready',{});
  for(const job of f.ledger.jobs())f.ledger.update(job.id,'exception',{});
  assert.throws(authorize,/One complete/);
  f.ledger.update(f.id,'ready',{});assert.equal(authorize().stage,'pilot');
  assert.equal(certified.rolloutStatus(f.ledger,f.context.fingerprints).completeDryRuns,1);
  f.ledger.set('paused',true);assert.throws(authorize,/Runner is paused/);f.ledger.set('paused',false);
  f.ledger.update(f.id,'uncertain',{});assert.throws(authorize,/reconciliation/);f.ledger.update(f.id,'ready',{});
  for(const field of ['deadline','start']){
    f.ledger.update(f.id,'ready',{[field]:'2000-01-01'});
    assert.throws(authorize,/One complete|deadline passed|start date passed/);
    f.ledger.update(f.id,'ready',{[field]:original.payload[field]});
  }
  assert.equal(authorize().stage,'pilot');assert.equal(f.ledger.status().attempts.length,0);assertProductionAdapters();
});

test('live orchestration rejects posting and reviewed-channel drift at the final source boundary before send',async t=>{
  const f=await fixture(t);f.unlock();const original=f.ledger.job(f.id);let posts=0;
  fixtureBoundary.accessProvider=f.accessProvider;
  fixtureBoundary.fetcher=async()=>{posts++;throw new Error('Source drift must refuse before transport');};
  t.after(()=>{delete fixtureBoundary.fetcher;delete fixtureBoundary.accessProvider;});
  const base={root:f.root,dryRun:false,jobIds:[f.id],evaluate:async()=>{throw new Error('No live evaluation');}};
  const posting=await orchestration.run({...base,fetchJD:async()=>({text:original.payload.jd+' Synthetic changed posting requirement.'})});
  assert.equal(posting.submitted,0);assert.equal(posting.blocked,1);assert.match(f.ledger.job(f.id).payload.reasons.join(),/sources changed/);
  assert.equal(posts,0);assert.equal(f.ledger.status().attempts.length,0);
  f.ledger.update(f.id,'ready',original.payload);
  const registry=path.join(f.root,'data/autonomous/email-channels.json'),saved=fs.readFileSync(registry,'utf8'),channels=JSON.parse(saved);
  channels[original.url].recipient='changed@employer.invalid';fs.writeFileSync(registry,JSON.stringify(channels));
  await assert.rejects(orchestration.run({...base,fetchJD:async()=>({text:original.payload.jd})}),/One complete/);
  assert.equal(posts,0);assert.equal(f.ledger.status().attempts.length,0);
  fs.writeFileSync(registry,saved);assert.equal(certified.rolloutStatus(f.ledger,loadContext(f.root).fingerprints).completeDryRuns,5);
  assertProductionAdapters();
});


test('one individually verified email bundle authorizes and completes real live orchestration without both tracks',async t=>{
  const f=await fixture(t),selected=f.ledger.job(f.id);let posts=0;
  for(const job of f.ledger.jobs().filter(j=>j.id!==f.id))f.ledger.update(job.id,'exception',{});
  const state=certified.authorizeSubmission(f.ledger,f.id,f.context.fingerprints,'gmail');
  assert.equal(state.stage,'pilot');assert.equal(state.limit,3);assert.equal(state.completeDryRuns,1);assert.deepEqual(state.tracks,[selected.track]);
  f.unlock();fixtureBoundary.accessProvider=f.accessProvider;
  fixtureBoundary.fetcher=async(url,options)=>{posts++;assert.ok(url.endsWith('/messages/send'));assert.equal(options.method,'POST');return {ok:true,json:async()=>({id:'synthetic-single-ready'})};};
  t.after(()=>{delete fixtureBoundary.fetcher;delete fixtureBoundary.accessProvider;});
  const result=await orchestration.run({root:f.root,dryRun:false,jobIds:[f.id],fetchJD:async url=>{assert.equal(url,selected.url);return {text:selected.payload.jd};},evaluate:async()=>{throw new Error('No live evaluation');}});
  assert.equal(result.submitted,1);assert.deepEqual(result.tracker,{synced:1,failed:0});assert.equal(posts,1);
  assert.equal(f.ledger.job(f.id).state,'applied');assert.equal(f.ledger.status().attempts.length,1);
  assert.match(fs.readFileSync(process.env.CAREER_OPS_TRACKER,'utf8'),/receipt gmail-accepted: synthetic-single-ready/);
  assert.ok(f.ledger.jobs().filter(j=>j.id!==f.id).every(j=>j.state==='exception'));assertProductionAdapters();
});
