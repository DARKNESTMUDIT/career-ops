import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assess, hash, validateClaims, dayInIndia } from '../autonomous/policy.mjs';
import { Ledger } from '../autonomous/ledger.mjs';
import { run, importPipeline } from '../autonomous/runner.mjs';
import { modelSelection } from '../autonomous/model.mjs';

const policy = { minimumFit: 4, unpaidFit: 4.5, tracks: { remote: { earliest_start: 'immediate', latest_end: '2027-06-30', max_months: 6, max_hours_per_week: 40 }, summer: { earliest_start: '2027-07-01', latest_end: '2027-08-31', max_months: 2, max_hours_per_week: 40 } } };
const text = 'Acme product research internship: fully remote India students eligible 40 hours weekly. Start January 1 2027, end June 30 2027. Apply by December 1 2026. Paid research and product work with a supervised project.';
function job(overrides = {}) { const j = { company:'Acme',role:'Product research intern',track:'remote',start:'2027-01-01',end:'2027-06-30',deadline:'2026-12-01',hours:40,indiaEligible:true,studentEligible:true,remote:true,country:'India',duties:'substantive',pay:'paid',fit:4.5,active:true,jd:text,evidence:{} }; for (const k of Object.keys(j)) j.evidence[k] = text; return { ...j, ...overrides }; }
function scratch(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-')); t.after(() => fs.rmSync(root, { recursive:true, force:true })); return root; }
test('India eligibility, dates, duration, hours and excluded duties are hard gates', () => {
  assert.equal(assess(job(),policy,'2026-10-09').state,'eligible');
  for (const bad of [{indiaEligible:false},{start:'2027-02-01',end:'2027-07-31'},{track:'summer',start:'2027-06-01',end:'2027-08-31'},{remote:false},{hours:41},{duties:'excluded'},{fit:3.9}]) assert.equal(assess(job(bad),policy,'2026-10-09').state,'rejected',JSON.stringify(bad));
});
test('unknown facts and hallucinated evidence cannot clear readiness', () => {
  for (const bad of [{hours:null},{start:null},{indiaEligible:null},{evidence:{}},{active:false},{deadline:'2026-02-31'}]) assert.notEqual(assess(job(bad),policy,'2026-10-09').state,'eligible');
  assert.equal(assess(job({pay:'unpaid'}),policy,'2026-10-09').state,'exception');
  assert.equal(assess(job({pay:'undisclosed'}),policy,'2026-10-09').state,'eligible');
});
test('unpaid requires quality evidence; summer two-month role can qualify', () => {
  assert.equal(assess(job({pay:'unpaid',credibleEmployer:true,project:true,supervision:true,evidence:{...job().evidence,credibleEmployer:text,project:text,supervision:text}}),policy,'2026-10-09').state,'eligible');
  assert.equal(assess(job({track:'summer',start:'2027-07-01',end:'2027-08-31',remote:false}),policy,'2026-10-09').state,'eligible');
});
test('exact candidate claim provenance rejects numeric and scope drift', () => {
  const sources = {'cv.md':'CGPA 8.18; 100+ prompts'};
  assert.equal(validateClaims([{text:'CGPA 8.18',quote:'CGPA 8.18',source:'cv.md'}],sources),true);
  assert.throws(()=>validateClaims([{text:'CGPA 9.18',quote:'CGPA 8.18',source:'cv.md'}],sources));
  assert.throws(()=>validateClaims([{text:'500 apps',quote:'500 apps',source:'memory.md'}],sources));
});
test('cross-process lock, global pause, uncertain recovery and no retry', t => {
  const root=scratch(t), a=new Ledger(root), b=new Ledger(root); t.after(()=>{a.close();b.close();});
  assert.equal(a.status().stage,'dry-run');
  const token=a.acquire(); assert.throws(()=>b.acquire(),/active/);
  const id=a.add('https://jobs.lever.co/acme/123'); assert.equal(a.add('https://jobs.lever.co/acme/123?utm_source=x'),id);
  a.update(id,'ready',{fingerprints:{cv:'v1'}}); a.set('stage','pilot'); b.set('paused',true);
  assert.throws(()=>a.reserve(id,{limit:5,fingerprints:{cv:'v1'}}),/paused/);
  b.set('paused',false); assert.throws(()=>a.reserve(id,{limit:5,fingerprints:{cv:'v2'}}),/Stale/);
  a.reserve(id,{limit:5,fingerprints:{cv:'v1'}}); assert.throws(()=>a.retry(id),/Only/);
  a.release(token); const second=b.acquire(); assert.equal(b.job(id).state,'uncertain'); b.release(second);
  assert.throws(()=>a.retry(id),/Only/); assert.throws(()=>a.receipt(id,{kind:'guess'}),/evidence/);
  a.receipt(id,{kind:'form-confirmation',reference:'fixture receipt'}); assert.equal(a.job(id).state,'confirmed');
});
test('daily cap counts intents, even if outcome is unresolved', t => {
  const l=new Ledger(scratch(t)); t.after(()=>l.close()); l.set('stage','initial');
  const id=l.add('https://jobs.lever.co/acme/1'); l.update(id,'ready',{fingerprints:{}}); l.reserve(id,{limit:1,fingerprints:{}}); l.receipt(id,{kind:'form-confirmation',reference:'receipt'});
  const next=l.add('https://jobs.lever.co/acme/2'); l.update(next,'ready',{fingerprints:{}}); assert.throws(()=>l.reserve(next,{limit:1,fingerprints:{}}),/Daily/);
});
test('configured model is retained without importing hooks or provider credentials', () => {
  assert.deepEqual(modelSelection('model = "example"\nmodel_reasoning_effort = "high"\n[mcp_servers.x]\ncommand = "bad"'),['-c','model="example"','-c','model_reasoning_effort="high"']);
});
test('discovery imports ranked pending jobs but excludes completed entries', t => {
  const root=scratch(t), l=new Ledger(root);t.after(()=>l.close());
  fs.writeFileSync(path.join(root,'data/pipeline.md'),'- [ ] https://jobs.lever.co/a/1 | A | Role | rank: 4.5\n- [x] https://jobs.lever.co/a/2 | A | Done');
  assert.equal(importPipeline(l,root),1);assert.equal(l.jobs().length,1);
});
test('India date rolls over independently of host timezone', () => assert.equal(dayInIndia(new Date('2026-10-08T20:00:00Z')),'2026-10-09'));
test('dry-run rejects live activation and preserves unsupported sources as exceptions', async t => {
  const root=scratch(t); fs.mkdirSync(path.join(root,'config')); fs.mkdirSync(path.join(root,'modes')); fs.mkdirSync(path.join(root,'data'));
  fs.writeFileSync(path.join(root,'cv.md'),'# Candidate\nSource backed experience');
  fs.writeFileSync(path.join(root,'config/profile.yml'),JSON.stringify({availability:policy.tracks}));
  fs.writeFileSync(path.join(root,'modes/_profile.md'),'Target'); fs.writeFileSync(path.join(root,'modes/_custom.md'),'Policy');
  fs.writeFileSync(path.join(root,'data/pipeline.md'),'- [ ] https://internshala.com/internship/details/example | test |');
  await assert.rejects(run({root,dryRun:false}),/Live adapters/);
  const result=await run({root, fetchJD: async()=>{throw new Error('Posting unavailable');}}); assert.equal(result.exceptions,1);
  const l=new Ledger(root); assert.equal(l.jobs()[0].state,'exception'); l.close();
});
test('eligible preparation is durable, source-backed, and invalidated by CV changes', async t => {
  const root=scratch(t);fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'modes'));fs.mkdirSync(path.join(root,'data'));
  fs.writeFileSync(path.join(root,'cv.md'),'# Candidate\n\nCGPA 8.18');
  fs.writeFileSync(path.join(root,'config/profile.yml'),JSON.stringify({availability:policy.tracks}));
  for(const f of ['_profile.md','_custom.md'])fs.writeFileSync(path.join(root,'modes',f),'Approved context');
  fs.writeFileSync(path.join(root,'data/pipeline.md'),'- [ ] https://jobs.lever.co/acme/1 | Acme | Research');
  const opts={root,fetchJD:async()=>({text}),evaluate:async()=>job()};
  assert.equal((await run(opts)).prepared,1);
  let l=new Ledger(root);let prepared=l.jobs()[0];assert.equal(prepared.state,'prepared');assert.equal(l.status().stage,'dry-run');l.close();
  const claims=JSON.parse(fs.readFileSync(path.join(prepared.payload.bundle,'claims.json'),'utf8'));assert.ok(claims.some(c=>c.text==='CGPA 8.18'));
  assert.equal((await run(opts)).evaluated,0);
  fs.appendFileSync(path.join(root,'cv.md'),'\nApproved new fact');
  assert.equal((await run(opts)).prepared,1);
  l=new Ledger(root);assert.equal(l.status().attempts.length,0);l.close();
});
