import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Ledger} from '../autonomous/ledger.mjs';
import {run} from '../autonomous/runner.mjs';
import {hash,dayInIndia} from '../autonomous/policy.mjs';

// Real runner, authorization, transport, ledger and tracker; only external Gmail
// credential/network boundaries are replaced. No production globals are changed.
const dataModule=source=>`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const absoluteImports=(source,file)=>source.replace(/from '(\.\.?\/[^']+)'/g,(_,relative)=>`from '${new URL(relative,file).href}'`);
const boundaryURL=dataModule(`export const calls={credentials:0,sends:0};
export async function access(){calls.credentials++;return {email:'candidate@example.invalid',token:'synthetic-access'};}
export async function network(url,options){if(url!=='https://gmail.googleapis.com/gmail/v1/users/me/messages/send'||options.method!=='POST')throw new Error('Unexpected fixture network request');calls.sends++;return {ok:true,json:async()=>({id:'synthetic-evaluation-block-receipt'})};}`);
const boundary=await import(boundaryURL);
const gmailFile=new URL('../autonomous/gmail.mjs',import.meta.url);
const gmailSource=fs.readFileSync(gmailFile,'utf8')
  .replace("import { gmailAccess } from './gmail-auth.mjs';",`import {access as gmailAccess,network as fixtureFetch} from '${boundaryURL}';`)
  .replaceAll('fetcher=fetch','fetcher=fixtureFetch');
const gmailURL=dataModule(absoluteImports(gmailSource,gmailFile));
const runnerFile=new URL('../autonomous/runner.mjs',import.meta.url);
const runnerSource=fs.readFileSync(runnerFile,'utf8')
  .replace("from 'js-yaml'",`from '${import.meta.resolve('js-yaml')}'`)
  .replace("from './gmail.mjs'",`from '${gmailURL}'`)
  .replaceAll('import.meta.url',JSON.stringify(runnerFile.href));
const isolatedRunner=await import(dataModule(absoluteImports(runnerSource,runnerFile)));

const jd='Synthetic Employer invites students in India to apply for a paid fully remote Product Research Intern role. The internship involves substantive product research and consulting work with a supervised project. Apply for this role by emailing jobs@employer.invalid.';
const output={company:'Synthetic Employer',role:'Product Research Intern',track:'remote',start:null,end:null,deadline:null,hours:null,indiaEligible:true,studentEligible:true,remote:true,country:'India',duties:'substantive',pay:'paid',fit:4.5,evidence:{}};
for(const key of Object.keys(output))if(key!=='evidence')output.evidence[key]=jd;
function fixture(t,fullScale=true) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'autonomous-evaluation-block-'));
  const saved=Object.fromEntries(['CAREER_OPS_ROOT','CAREER_OPS_DATA_DIR','CAREER_OPS_TRACKER'].map(key=>[key,process.env[key]]));
  process.env.CAREER_OPS_ROOT=root;delete process.env.CAREER_OPS_DATA_DIR;process.env.CAREER_OPS_TRACKER=path.join(root,'data/applications.md');
  for(const dir of ['config','modes','data'])fs.mkdirSync(path.join(root,dir));
  fs.writeFileSync(path.join(root,'cv.md'),'# Synthetic Candidate\n\n## Experience\n- Product research and consulting experiments\n');
  fs.writeFileSync(path.join(root,'config/profile.yml'),JSON.stringify({candidate:{full_name:'Synthetic Candidate',email:'candidate@example.invalid'},target_roles:{primary:['Product Research Intern']},availability:{remote:{earliest_start:'immediate',latest_end:'2099-06-30',max_months:6,max_hours_per_week:40,workplace:'fully remote from India'},summer:{earliest_start:'2099-07-01',latest_end:'2099-08-31',max_months:2,max_hours_per_week:40,workplace:'on-site India or remote'}}}));
  fs.writeFileSync(path.join(root,'modes/_profile.md'),'Synthetic approved research targeting');
  fs.writeFileSync(path.join(root,'modes/_custom.md'),`${fullScale?'<!-- career-ops:full-scale-applications=true -->\n':''}<!-- career-ops:apply-with-stated-availability=true -->`);
  const ledger=new Ledger(root),urls=['https://employer.invalid/ready','https://employer.invalid/timeout'];
  const channels=Object.fromEntries(urls.map(url=>[url,{verified:true,roleUrl:url,sourceUrl:url,employerHost:'employer.invalid',company:output.company,role:output.role,recipient:'jobs@employer.invalid',quote:'Apply for this role by emailing jobs@employer.invalid.',postingHash:hash(jd)}]));
  fs.writeFileSync(path.join(root,'data/autonomous/email-channels.json'),JSON.stringify(channels));
  t.after(()=>{ledger.close();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(root,{recursive:true,force:true});});
  return {root,ledger,urls,fetchJD:async()=>({text:jd}),renderPDF:async(_html,destination)=>fs.writeFileSync(destination,'%PDF-1.4\n'+'x'.repeat(600))};
}

test('full-scale timeout blocks further same-day evaluation without globally pausing or discovering again',async t=>{
  const f=fixture(t);for(const url of f.urls)f.ledger.add(url);
  let evaluations=0;
  const first=await run({...f,evaluate:async()=>{evaluations++;throw new Error('Model timeout: synthetic provider');}});
  assert.equal(evaluations,1);assert.equal(first.evaluationAttempts,1);assert.equal(first.exceptions,1);
  assert.equal(f.ledger.get('paused'),false);
  assert.deepEqual(f.ledger.get('evaluationBlock'),{day:dayInIndia(),reason:'Model timeout: synthetic provider'});
  let discoveries=0,captures=0;
  const second=await run({...f,discover:async()=>{discoveries++;},fetchJD:async()=>{captures++;throw new Error('unexpected capture');},evaluate:async()=>{evaluations++;throw new Error('unexpected model');}});
  assert.equal(second.evaluationBlocked,'Model timeout: synthetic provider');
  assert.equal(second.evaluationAttempts,0);assert.equal(discoveries,0);assert.equal(captures,0);assert.equal(evaluations,1);
});

test('full-scale model usage exhaustion also creates an evaluation-only block',async t=>{
  const f=fixture(t);f.ledger.add(f.urls[0]);
  await run({...f,evaluate:async()=>{throw new Error('Model usage limit reached: synthetic');}});
  assert.equal(f.ledger.get('paused'),false);
  assert.equal(f.ledger.get('evaluationBlock').day,dayInIndia());
  assert.match(f.ledger.get('evaluationBlock').reason,/Model usage/);
});

test('previous-day evaluation block permits a fresh bounded model attempt',async t=>{
  const f=fixture(t);for(const url of f.urls)f.ledger.add(url);
  const previous=new Date(`${dayInIndia()}T00:00:00Z`);previous.setUTCDate(previous.getUTCDate()-1);
  f.ledger.set('evaluationBlock',{day:previous.toISOString().slice(0,10),reason:'Model timeout: previous day'});
  let evaluations=0,discoveries=0;
  const result=await run({...f,maxEvaluations:1,discover:async()=>{discoveries++;},evaluate:async()=>{evaluations++;return {};}});
  assert.equal(evaluations,1);assert.equal(discoveries,1);assert.equal(result.evaluationAttempts,1);
  assert.equal(f.ledger.get('evaluationBlock'),null);assert.equal(f.ledger.get('paused'),false);
});

test('same-day evaluation block permits an already verified Gmail packet through normal live gates and durable tracker sync',async t=>{
  const f=fixture(t),id=f.ledger.add(f.urls[0]);
  const prepared=await run({...f,maxEvaluations:1,evaluate:async()=>structuredClone(output)});
  assert.equal(prepared.complete,1,JSON.stringify(f.ledger.job(id).payload.reasons));assert.equal(f.ledger.job(id).state,'ready');
  f.ledger.add(f.urls[1]);
  await run({...f,maxEvaluations:1,evaluate:async()=>{throw new Error('Model timeout: evaluation only');}});
  assert.equal(f.ledger.get('paused'),false);assert.equal(f.ledger.job(id).state,'ready');
  boundary.calls.credentials=0;boundary.calls.sends=0;
  let evaluations=0;
  const result=await isolatedRunner.run({...f,dryRun:false,jobIds:[id],evaluate:async()=>{evaluations++;throw new Error('Live must not evaluate');}});
  assert.equal(result.submitted,1);assert.equal(result.tracker.synced,1);
  assert.equal(boundary.calls.credentials,1);assert.equal(boundary.calls.sends,1);assert.equal(evaluations,0);
  assert.equal(f.ledger.job(id).state,'applied');assert.equal(f.ledger.get('paused'),false);
  assert.equal(f.ledger.get('evaluationBlock').day,dayInIndia());
  assert.match(fs.readFileSync(process.env.CAREER_OPS_TRACKER,'utf8'),/synthetic-evaluation-block-receipt/);
  assert.equal(f.ledger.status().attempts.length,1);
});

test('normal rollout preserves global pause on a model timeout',async t=>{
  const f=fixture(t,false);f.ledger.add(f.urls[0]);
  await run({...f,evaluate:async()=>{throw new Error('Model timeout: normal mode');}});
  assert.equal(f.ledger.get('paused'),true);assert.equal(f.ledger.get('evaluationBlock'),null);
});

test('full-scale unavailable captures do not consume the bounded model evaluation budget',async t=>{
  const f=fixture(t);
  const urls=Array.from({length:4},(_,i)=>`https://employer.invalid/evaluation-budget-${i}`);
  const ids=urls.map(url=>f.ledger.add(url));
  // Explicit timestamps make queue order independent of millisecond collisions.
  ids.forEach((id,index)=>f.ledger.db.prepare('UPDATE jobs SET updated=? WHERE id=?').run(`2026-10-23T00:00:0${3-index}.000Z`,id));
  let captures=0,evaluations=0;
  const result=await run({...f,maxEvaluations:1,fetchJD:async url=>{
    captures++;return urls.slice(0,2).includes(url)?null:{text:jd};
  },evaluate:async()=>{evaluations++;return {};}});
  assert.equal(captures,3);assert.equal(result.inspected,3);
  assert.equal(evaluations,1);assert.equal(result.evaluationAttempts,1);
  assert.equal(f.ledger.job(ids[3]).state,'discovered');
  assert.equal(f.ledger.get('paused'),false);
});
