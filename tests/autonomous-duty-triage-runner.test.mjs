import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Ledger} from '../autonomous/ledger.mjs';
import {run} from '../autonomous/runner.mjs';

function capture(mixed=false) {
  return {method:'internshala-public-html-and-jsonld',text:
    'Internshala exact-posting public role text: Synthetic role\n'+
    'Internshala exact-posting JobPosting JSON-LD description (independent source section; retain any differences from body text):\n'+
    "Selected intern's day-to-day responsibilities include:\n\n1. Make cold calls to prospects daily.\n\n2. Generate new sales leads for the team.\n\n3. "+
    (mixed?'Conduct market research and analyse product strategy.':'Close sales deals with customers.')+
    '\n\nWho can apply:\nHave relevant interests.\n\nInternshala exact-posting JobPosting JSON-LD metadata (verbatim values; country codes are provider data):\n{}'};
}
function fixture(t,enabled=true) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'duty-runner-'));
  const keys=['CAREER_OPS_ROOT','CAREER_OPS_DATA_DIR','CAREER_OPS_TRACKER'];
  const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  process.env.CAREER_OPS_ROOT=root;delete process.env.CAREER_OPS_DATA_DIR;
  process.env.CAREER_OPS_TRACKER=path.join(root,'data/applications.md');
  for(const dir of ['config','modes','data'])fs.mkdirSync(path.join(root,dir));
  fs.writeFileSync(path.join(root,'cv.md'),'# Synthetic candidate\nResearch experience');
  fs.writeFileSync(path.join(root,'config/profile.yml'),JSON.stringify({availability:{remote:{latest_end:'2099-06-30'},summer:{latest_end:'2099-07-31'}}}));
  fs.writeFileSync(path.join(root,'modes/_profile.md'),'Synthetic research targeting');
  fs.writeFileSync(path.join(root,'modes/_custom.md'),'<!-- career-ops:full-scale-applications=true -->\n'+(enabled?'<!-- career-ops:deterministic-sales-triage=true -->':''));
  const ledger=new Ledger(root),ids=[ledger.add('https://employer.invalid/first'),ledger.add('https://employer.invalid/second')];
  ids.forEach((id,i)=>ledger.db.prepare('UPDATE jobs SET updated=? WHERE id=?').run(`2020-01-0${2-i}T00:00:00Z`,id));
  t.after(()=>{ledger.close();for(const k of keys){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}fs.rmSync(root,{recursive:true,force:true});});
  return {root,ledger,ids};
}
test('explicit excluded duties save model budget for the next posting and retain exact proof',async t=>{
  const f=fixture(t);let calls=0;
  const result=await run({...f,maxEvaluations:1,fetchJD:async url=>capture(url.endsWith('second')),evaluate:async()=>{calls++;return {};}});
  assert.equal(calls,1);assert.equal(result.evaluationAttempts,1);assert.equal(result.inspected,2);
  const rejected=f.ledger.job(f.ids[0]);
  assert.equal(rejected.state,'rejected');assert.equal(rejected.payload.dryRunComplete,false);
  assert.equal(rejected.payload.deterministicTriage.quotes.length,3);
  assert.ok(rejected.payload.jd.includes(rejected.payload.deterministicTriage.quotes[0].quote));
  assert.equal(f.ledger.db.prepare('SELECT COUNT(*) n FROM attempts').get().n,0);
});
test('without trusted workflow marker even a sales list goes to normal evaluation',async t=>{
  const f=fixture(t,false);let calls=0;
  await run({...f,jobIds:[f.ids[0]],fetchJD:async()=>capture(),evaluate:async()=>{calls++;return {};}});
  assert.equal(calls,1);assert.equal(f.ledger.job(f.ids[0]).payload.deterministicTriage,undefined);
});
test('mixed strategic work remains eligible for model evaluation despite sales words',async t=>{
  const f=fixture(t);let calls=0;
  await run({...f,jobIds:[f.ids[0]],fetchJD:async()=>capture(true),evaluate:async()=>{calls++;return {};}});
  assert.equal(calls,1);assert.equal(f.ledger.job(f.ids[0]).payload.deterministicTriage,undefined);
});
