import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../autonomous/ledger.mjs';
import { run } from '../autonomous/runner.mjs';
import { dayInIndia } from '../autonomous/policy.mjs';

const posting='Synthetic employer seeks an India eligible student for a paid fully remote product research internship with substantive duties and project supervision. '.repeat(2);
function fixture(t,{marker=true,fullScale=true,count=2}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sol-fallback-'));
  const prior=Object.fromEntries(['CAREER_OPS_ROOT','CAREER_OPS_DATA_DIR','CAREER_OPS_TRACKER','CAREER_OPS_PLANNER_MODEL','CAREER_OPS_PLANNER_REASONING_EFFORT'].map(key=>[key,process.env[key]]));
  process.env.CAREER_OPS_ROOT=root;
  delete process.env.CAREER_OPS_DATA_DIR;
  process.env.CAREER_OPS_TRACKER=path.join(root,'data/applications.md');
  process.env.CAREER_OPS_PLANNER_MODEL='gpt-6.1-sol';
  process.env.CAREER_OPS_PLANNER_REASONING_EFFORT='medium';
  for(const dir of ['config','modes','data'])fs.mkdirSync(path.join(root,dir));
  fs.writeFileSync(path.join(root,'cv.md'),'# Synthetic candidate\nProduct research experience');
  fs.writeFileSync(path.join(root,'config/profile.yml'),JSON.stringify({availability:{remote:{earliest_start:'immediate',latest_end:'2099-06-30',max_months:6,max_hours_per_week:40},summer:{earliest_start:'2099-07-01',latest_end:'2099-08-31',max_months:2,max_hours_per_week:40}}}));
  fs.writeFileSync(path.join(root,'modes/_profile.md'),'Synthetic target');
  fs.writeFileSync(path.join(root,'modes/_custom.md'),`${fullScale?'<!-- career-ops:full-scale-applications=true -->\n':''}${marker?'<!-- career-ops:sol-timeout-fallback=true -->':''}`);
  const ledger=new Ledger(root);
  const ids=Array.from({length:count},(_,i)=>ledger.add(`https://employer.invalid/role-${i}`));
  t.after(()=>{ledger.close();for(const [key,value] of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(root,{recursive:true,force:true});});
  return {root,ledger,ids,fetchJD:async()=>({text:posting})};
}
const primaryTimeout=async()=>{throw new Error('Model timeout: primary');};
const fallbackSuccess=async()=>({});

test('primary timeout switches once to Sol, preserves primary block, and counts both attempts',async t=>{
  const f=fixture(t);let primary=0,fallback=0;
  const result=await run({...f,maxEvaluations:3,evaluate:async()=>{primary++;return primaryTimeout();},fallbackEvaluate:async()=>{fallback++;return fallbackSuccess();}});
  assert.equal(primary,1);assert.equal(fallback,2);
  assert.equal(result.evaluationAttempts,3);assert.equal(result.evaluated,2);
  assert.equal(result.modelFallback,'gpt-6-sol');
  assert.deepEqual(f.ledger.get('evaluationBlock'),{day:dayInIndia(),reason:'Model timeout: primary',model:'gpt-6.1-sol',fallback:{model:'gpt-6-sol',status:'available'}});
  assert.equal(f.ledger.get('paused'),false);
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='evaluation-fallback-probe'").get().n,1);
});

test('usage and authentication exhaustion never use fallback',async t=>{
  const f=fixture(t,{count:1});let fallback=0;
  await run({...f,evaluate:async()=>{throw new Error('Model usage/authentication unavailable');},fallbackEvaluate:async()=>{fallback++;return {};}});
  assert.equal(fallback,0);
  assert.deepEqual(f.ledger.get('evaluationBlock'),{day:dayInIndia(),reason:'Model usage/authentication unavailable'});
});

test('failed fallback preserves both errors and is never retried on unchanged day',async t=>{
  const f=fixture(t);let primary=0,fallback=0;
  await run({...f,evaluate:async()=>{primary++;return primaryTimeout();},fallbackEvaluate:async()=>{fallback++;throw new Error('Model failed (1)');}});
  assert.equal(primary,1);assert.equal(fallback,1);
  assert.deepEqual(f.ledger.get('evaluationBlock'),{day:dayInIndia(),reason:'Model timeout: primary',model:'gpt-6.1-sol',fallback:{model:'gpt-6-sol',status:'blocked',reason:'Model failed (1)'}});
  const second=await run({...f,evaluate:async()=>{primary++;return {};},fallbackEvaluate:async()=>{fallback++;return {};}});
  assert.equal(second.evaluationAttempts,0);assert.equal(primary,1);assert.equal(fallback,1);
});

test('one remaining evaluation slot records timeout and defers fallback to next bounded run',async t=>{
  const f=fixture(t);let primary=0,fallback=0;
  const first=await run({...f,maxEvaluations:1,evaluate:async()=>{primary++;return primaryTimeout();},fallbackEvaluate:async()=>{fallback++;return {};}});
  assert.equal(first.evaluationAttempts,1);assert.equal(fallback,0);
  assert.equal(f.ledger.get('evaluationBlock').fallback.status,'pending');
  const second=await run({...f,maxEvaluations:1,evaluate:async()=>{primary++;return {};},fallbackEvaluate:async()=>{fallback++;return {};}});
  assert.equal(second.evaluationAttempts,1);assert.equal(primary,1);assert.equal(fallback,1);
  assert.equal(f.ledger.get('evaluationBlock').fallback.status,'available');
});

test('previous-day block permits primary retry; paused runner does not evaluate',async t=>{
  const f=fixture(t,{count:1});
  f.ledger.set('evaluationBlock',{day:'2026-10-23',reason:'Model timeout: primary',model:'gpt-6.1-sol',fallback:{model:'gpt-6-sol',status:'blocked'}});
  let primary=0,fallback=0;
  await run({...f,evaluate:async()=>{primary++;return {};},fallbackEvaluate:async()=>{fallback++;return {};}});
  assert.equal(primary,1);assert.equal(fallback,0);assert.equal(f.ledger.get('evaluationBlock'),null);
  f.ledger.set('paused',true);
  const result=await run({...f,evaluate:async()=>{primary++;return {};},fallbackEvaluate:async()=>{fallback++;return {};}});
  assert.equal(result.paused,true);assert.equal(primary,1);assert.equal(fallback,0);
});

test('trusted marker maps a legacy timeout without losing its reason',async t=>{
  const f=fixture(t,{count:1});
  f.ledger.set('evaluationBlock',{day:dayInIndia(),reason:'Model timeout'});
  let primary=0,fallback=0;
  await run({...f,evaluate:async()=>{primary++;return {};},fallbackEvaluate:async()=>{fallback++;return {};}});
  assert.equal(primary,0);assert.equal(fallback,1);
  assert.equal(f.ledger.get('evaluationBlock').reason,'Model timeout');
  assert.equal(f.ledger.get('evaluationBlock').fallback.status,'available');
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='evaluation-fallback-legacy-block'").get().n,1);
});

test('without trusted marker, existing whole-day timeout block remains unchanged',async t=>{
  const f=fixture(t,{marker:false,count:1});
  f.ledger.set('evaluationBlock',{day:dayInIndia(),reason:'Model timeout'});
  let fallback=0;
  const result=await run({...f,evaluate:async()=>({}),fallbackEvaluate:async()=>{fallback++;return {};}});
  assert.equal(result.evaluationBlocked,'Model timeout');assert.equal(fallback,0);
  assert.deepEqual(f.ledger.get('evaluationBlock'),{day:dayInIndia(),reason:'Model timeout'});
});

test('a different configured primary cannot inherit the Sol timeout route',async t=>{
  const f=fixture(t,{count:1});process.env.CAREER_OPS_PLANNER_MODEL='gpt-6-astra';
  let fallback=0;
  await run({...f,evaluate:primaryTimeout,fallbackEvaluate:async()=>{fallback++;return {};}});
  assert.equal(fallback,0);
  assert.deepEqual(f.ledger.get('evaluationBlock'),{day:dayInIndia(),reason:'Model timeout: primary'});
});

test('fallback usage exhaustion remains attached to its failed model',async t=>{
  const f=fixture(t);let fallback=0;
  await run({...f,evaluate:primaryTimeout,fallbackEvaluate:async()=>{fallback++;throw new Error('Model usage/authentication unavailable');}});
  assert.equal(fallback,1);
  assert.equal(f.ledger.get('evaluationBlock').reason,'Model timeout: primary');
  assert.deepEqual(f.ledger.get('evaluationBlock').fallback,{model:'gpt-6-sol',status:'blocked',reason:'Model usage/authentication unavailable'});
});
