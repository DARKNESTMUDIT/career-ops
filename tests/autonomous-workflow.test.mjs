import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Ledger } from '../autonomous/ledger.mjs';
import { run, loadContext } from '../autonomous/runner.mjs';
import { tailoredResume, verifyBundle } from '../autonomous/bundle.mjs';
import { prepareForm, sameJobChannel, uploadedHash, answerField, submitPrepared, validatePreparedForm } from '../autonomous/browser.mjs';
import { rolloutStatus, authorizeSubmission, integrityPause, pendingWork, recordOperatingDay } from '../autonomous/rollout.mjs';
import { syncReceipt, retryTrackerSync } from '../autonomous/tracker.mjs';
import { oauthRequest, GMAIL_SCOPES, connectGmail } from '../autonomous/gmail-auth.mjs';
import { hash, dayInIndia } from '../autonomous/policy.mjs';

function scratch(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'autonomous-workflow-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['config','modes','data'])fs.mkdirSync(path.join(root,dir));
  fs.writeFileSync(path.join(root,'cv.md'),'<!-- private provenance\nnot for resume -->\n# Example Candidate\n\n## Experience\n### Example Employer\n- Product research with 10 interviews\n- AI prompt experiments\n');
  fs.writeFileSync(path.join(root,'config/profile.yml'),JSON.stringify({candidate:{full_name:'Example Candidate',email:'candidate@example.invalid'},availability:{remote:{earliest_start:'immediate',latest_end:'2027-06-30',max_months:6,max_hours_per_week:40},summer:{earliest_start:'2027-07-01',latest_end:'2027-08-31',max_months:2,max_hours_per_week:40}}}));
  for(const name of ['_profile','_custom'])fs.writeFileSync(path.join(root,`modes/${name}.md`),'Fixture context');
  return root;
}
const jd='Example Company invites students in India to apply for a paid fully remote product research internship. Work 40 hours weekly from 2027-01-01 to 2027-06-30, or summer from 2027-07-01 to 2027-08-31. Deadline 2026-12-01. Research users and AI applications.';
const evaluated = (n=0,track='remote') => {
  const j={company:`Example Company ${n}`,role:'Product research intern',track,start:track==='remote'?'2027-01-01':'2027-07-01',end:track==='remote'?'2027-06-30':'2027-08-31',deadline:'2026-12-01',hours:40,indiaEligible:true,studentEligible:true,remote:true,country:'India',duties:'substantive',pay:'paid',fit:4.5,evidence:{}};
  for(const k of Object.keys(j))j.evidence[k]=jd;
  return j;
};
async function fixtureBrowser(t) {
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  return async ({context,resumePath})=>{
    const page=await browser.newPage();
    try {
      await page.setContent('<form><label>Full name<input required></label><label>Email<input type="email" required></label><label>Resume<input type="file" required></label><button type="submit">Submit application</button></form>');
      return await prepareForm(page,context.profile,resumePath);
    } finally {await page.close();}
  };
}
test('complete dry run produces a real PDF, exact upload and immutable manifest; CV and posting edits invalidate it',async t=>{
  const root=scratch(t),l=new Ledger(root);l.add('https://jobs.lever.co/example/1');l.close();
  const prepare=await fixtureBrowser(t);let posting=jd;
  const opts={root,fetchJD:async()=>({text:posting}),evaluate:async()=>evaluated(),prepare};
  assert.equal((await run(opts)).complete,1);
  const db=new Ledger(root);t.after(()=>db.close());
  const ready=db.jobs()[0];assert.equal(ready.state,'ready');
  assert.ok(fs.statSync(path.join(ready.payload.bundle,'resume.pdf')).size>500);
  assert.ok(verifyBundle(ready.payload.bundle,ready.payload.fingerprints));
  assert.equal((await run(opts)).evaluated,0);
  fs.appendFileSync(path.join(root,'cv.md'),'\nApproved fixture fact');
  assert.equal((await run(opts)).complete,1);
  posting+=' Updated requirement.';
  assert.equal((await run(opts)).complete,1);
  fs.appendFileSync(path.join(ready.payload.bundle,'resume.pdf'),'tamper');
  assert.equal(verifyBundle(ready.payload.bundle,db.job(ready.id).payload.fingerprints),false);
  assert.equal(db.status().attempts.length,0);
});
test('five complete fixture bundles cover both tracks but cannot bypass adapter validation',async t=>{
  const root=scratch(t),db=new Ledger(root);t.after(()=>db.close());
  for(let i=0;i<5;i++)db.add(`https://jobs.lever.co/example/${i}`);
  let n=0;const result=await run({root,fetchJD:async()=>({text:jd}),evaluate:async()=>evaluated(n,n++%2?'summer':'remote'),prepare:await fixtureBrowser(t)});
  assert.equal(result.complete,5);assert.equal(result.rollout.stage,'pilot');
  assert.deepEqual(result.rollout.tracks.sort(),['remote','summer']);
  assert.equal(rolloutStatus(db,loadContext(root).fingerprints,'2026-12-02').completeDryRuns,0);
  assert.deepEqual(db.get('cleanDays') || [],[]);
  const context=loadContext(root);assert.throws(()=>authorizeSubmission(db,db.jobs()[0].id,context.fingerprints,'lever'),/validation pending/);
  integrityPause(db,'fixture integrity failure');assert.throws(()=>db.resume(),/integrity/);
  assert.equal(rolloutStatus(db,context.fingerprints).reasons.some(r=>r.includes('Integrity')),true);
});
test('fresh work shares a bounded capture budget with existing ready bundles',()=>{
  const jobs=Array.from({length:30},(_,i)=>({id:i,state:'ready',track:'remote',updated:'2026-10-09',payload:{deadline:'2026-10-10'}}));
  jobs.push({id:'new',state:'discovered',updated:'2026-10-09',payload:{}});
  assert.equal(pendingWork(jobs)[0].id,'new');
});
test('a later submission intent revokes earlier clean-day credit before a crash',t=>{
  const root=scratch(t),db=new Ledger(root);t.after(()=>db.close());
  const id=db.add('https://jobs.lever.co/example/clean-day');
  db.update(id,'ready',{fingerprints:{cv:'fixture'}});db.set('stage','initial');
  db.set('cleanDays',[dayInIndia()]);
  db.reserve(id,{limit:5,fingerprints:{cv:'fixture'}});
  assert.deepEqual(db.get('cleanDays'),[]);
  recordOperatingDay(db);assert.deepEqual(db.get('cleanDays'),[]);
});
test('unknown mandatory answers remain exceptions; no dry-run credit',async t=>{
  const root=scratch(t),db=new Ledger(root);t.after(()=>db.close());db.add('https://jobs.lever.co/example/1');
  const result=await run({root,fetchJD:async()=>({text:jd}),evaluate:async()=>evaluated(),prepare:async()=>({complete:false,issues:['Unknown required answer']})});
  assert.equal(result.exceptions,1);assert.equal(result.rollout.completeDryRuns,0);assert.equal(db.jobs()[0].state,'exception');
});
test('a model timeout pauses the runner without counting a completed evaluation',async t=>{
  const root=scratch(t),db=new Ledger(root);t.after(()=>db.close());db.add('https://jobs.lever.co/example/timeout');
  const result=await run({root,fetchJD:async()=>({text:jd}),evaluate:async()=>{throw new Error('Model timeout');}});
  assert.equal(result.evaluationAttempts,1);assert.equal(result.evaluated,0);
  assert.equal(result.exceptions,1);assert.equal(db.get('paused'),true);
  assert.equal(db.get('pauseReason'),'Model timeout');assert.equal(db.status().attempts.length,0);
});
test('canonical blacklist blocks an otherwise eligible role and invalidates prior context',async t=>{
  const root=scratch(t),db=new Ledger(root);t.after(()=>db.close());db.add('https://jobs.lever.co/example/1');
  const before=loadContext(root).fingerprints;
  fs.writeFileSync(path.join(root,'data/blacklist.md'),'| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Example Company 0 | 2026-10-09 | company | User excluded |\n');
  assert.notEqual(loadContext(root).fingerprints.blacklist,before.blacklist);
  const result=await run({root,fetchJD:async()=>({text:jd}),evaluate:async()=>evaluated(),prepare:async()=>{throw new Error('Must not prepare blacklisted role');}});
  assert.equal(result.rejected,1);assert.match(db.jobs()[0].payload.reasons.join(),/Do-not-apply/);
  assert.equal(db.status().attempts.length,0);
});
test('verified role-specific email dry run seals recipient and body without sending',async t=>{
  const root=scratch(t),db=new Ledger(root);t.after(()=>db.close());
  const url='https://jobs.lever.co/example/email';db.add(url);
  const posting=jd+' Apply for this role by emailing jobs@example.invalid.';
  const job=evaluated();
  const channel={verified:true,roleUrl:url,sourceUrl:'https://example.invalid/careers/research',employerHost:'example.invalid',company:job.company,role:job.role,recipient:'jobs@example.invalid',quote:'Apply for this role by emailing jobs@example.invalid.',postingHash:hash(posting)};
  fs.writeFileSync(path.join(root,'data/autonomous/email-channels.json'),JSON.stringify({[url]:channel}));
  const result=await run({root,fetchJD:async()=>({text:posting}),evaluate:async()=>job,prepare:async()=>{throw new Error('Email path must not open a form');}});
  assert.equal(result.complete,1);assert.equal(db.jobs()[0].payload.applicationKind,'email');
  const ready=db.jobs()[0];assert.ok(verifyBundle(ready.payload.bundle,ready.payload.fingerprints));
  fs.appendFileSync(path.join(ready.payload.bundle,'email.json'),' ');
  assert.equal(verifyBundle(ready.payload.bundle,ready.payload.fingerprints),false);
  assert.equal(db.status().attempts.length,0);
});
test('direct submit helper cannot bypass adapter validation or reserve an attempt',async t=>{
  const root=scratch(t),db=new Ledger(root);t.after(()=>db.close());
  const id=db.add('https://jobs.lever.co/example/guard');
  db.update(id,'ready',{...evaluated(),fingerprints:loadContext(root).fingerprints});
  await assert.rejects(submitPrepared(null,{ledger:db,id,context:loadContext(root),prepared:{complete:true},limit:10}),/validation pending/);
  assert.equal(db.status().attempts.length,0);
  assert.equal(db.job(id).state,'ready');
});
test('withdrawing a reviewed email channel revokes credit and requires fresh form preparation',async t=>{
  const root=scratch(t),db=new Ledger(root);t.after(()=>db.close());
  const url='https://jobs.lever.co/example/channel-change';db.add(url);
  const posting=jd+' Apply for this role by emailing jobs@example.invalid.';
  const job=evaluated();
  const channel={verified:true,roleUrl:url,sourceUrl:'https://example.invalid/careers/research',employerHost:'example.invalid',company:job.company,role:job.role,recipient:'jobs@example.invalid',quote:'Apply for this role by emailing jobs@example.invalid.',postingHash:hash(posting)};
  const registry=path.join(root,'data/autonomous/email-channels.json');
  fs.writeFileSync(registry,JSON.stringify({[url]:channel}));
  const options={root,fetchJD:async()=>({text:posting}),evaluate:async()=>job};
  assert.equal((await run({...options,prepare:async()=>{throw new Error('Unexpected form');}})).complete,1);
  assert.equal(db.jobs()[0].payload.applicationKind,'email');
  assert.equal(rolloutStatus(db,loadContext(root).fingerprints).completeDryRuns,1);
  fs.writeFileSync(registry,JSON.stringify({}));
  assert.equal(rolloutStatus(db,loadContext(root).fingerprints).completeDryRuns,0);
  const result=await run({...options,prepare:await fixtureBrowser(t)});
  assert.equal(result.evaluated,1);assert.equal(result.complete,1);
  assert.equal(db.jobs()[0].payload.applicationKind,'form');
  assert.equal(db.status().attempts.length,0);
});
test('resume preserves exact claims and strips multiline source comments',t=>{
  const context=loadContext(scratch(t));const resume=tailoredResume(context,{role:'AI',jd:'AI prompt research'});
  assert.ok(!resume.html.includes('private provenance'));assert.ok(!resume.html.includes('not for resume'));
  assert.ok(resume.claims.every(c=>context.sources[c.source].includes(c.text)));
});
test('same ATS host is insufficient to establish the same application channel',()=>{
  assert.equal(sameJobChannel('https://jobs.lever.co/a/123/apply','https://jobs.lever.co/a/123'),true);
  assert.equal(sameJobChannel('https://jobs.lever.co/b/123','https://jobs.lever.co/a/123'),false);
  assert.equal(answerField({label:'Reference email address',required:true},{candidate:{email:'me@example.invalid'}}).value,undefined);
});
test('exact upload detects a same-name replacement',async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent('<input type="file">');const loc=page.locator('input');
  await loc.setInputFiles({name:'resume.pdf',mimeType:'application/pdf',buffer:Buffer.from('original')});const before=await uploadedHash(loc);
  await loc.setInputFiles({name:'resume.pdf',mimeType:'application/pdf',buffer:Buffer.from('replacement')});assert.notEqual(await uploadedHash(loc),before);
});
test('final validation rejects a new required field after preparation',async t=>{
  const root=scratch(t),resumePath=path.join(root,'resume.pdf');fs.writeFileSync(resumePath,'%PDF-1.4 fixture');
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent('<form><label>Email<input type="email" required></label><label>Resume<input type="file" required></label><button>Submit application</button></form>');
  const prepared=await prepareForm(page,loadContext(root).profile,resumePath);
  await validatePreparedForm(page,prepared);
  await page.locator('form').evaluate(el=>{el.insertAdjacentHTML('beforeend','<label>Unanswered question<input required></label>');});
  await assert.rejects(validatePreparedForm(page,prepared),/Required application fields changed/);
});
test('receipt survives tracker failure, sync retries independently and is idempotent',async t=>{
  const root=scratch(t),db=new Ledger(root);t.after(()=>db.close());const id=db.add('https://jobs.lever.co/example/1');
  const unrelated=path.join(root,'batch/tracker-additions/unrelated.tsv');
  fs.mkdirSync(path.dirname(unrelated),{recursive:true});fs.writeFileSync(unrelated,'Unrelated pending batch work\n');
  db.update(id,'ready',{...evaluated(),bundle:path.join(root,'data/autonomous/bundles/fixture'),fingerprints:{cv:'v1'}});db.set('stage','pilot');db.reserve(id,{limit:3,fingerprints:{cv:'v1'}});
  const receipt={kind:'form-confirmation',reference:'fixture-receipt',at:'2026-10-09T12:00:00Z'};db.receipt(id,receipt);
  assert.deepEqual(await retryTrackerSync(root,db,{setStatus:async()=>{throw new Error('simulated tracker failure');}}),{synced:0,failed:1});
  assert.equal(db.job(id).state,'confirmed');assert.throws(()=>db.retry(id),/Only/);
  const synced=await retryTrackerSync(root,db);
  assert.deepEqual(synced,{synced:1,failed:0},db.job(id).payload.trackerSync?.error);
  await syncReceipt(root,db,id);db.receipt(id,receipt);
  assert.equal(db.job(id).state,'applied');
  const content=fs.readFileSync(path.join(root,'data/applications.md'),'utf8');assert.equal(content.split(`[autonomous:${id}]`).length-1,1);
  assert.match(fs.readFileSync(path.join(root,'data/status-log.tsv'),'utf8'),/Evaluated\tApplied/);
  assert.ok(fs.existsSync(path.join(root,'batch/tracker-additions/autonomous',id,'merged/receipt.tsv')));
  assert.equal(fs.readFileSync(unrelated,'utf8'),'Unrelated pending batch work\n');
  execFileSync(process.execPath,[fileURLToPath(new URL('../set-status.mjs',import.meta.url)),'--row','1','Interview','--json'],{env:{...process.env,CAREER_OPS_ROOT:root,CAREER_OPS_TRACKER:path.join(root,'data/applications.md')}});
  const advanced=fs.readFileSync(path.join(root,'data/applications.md'),'utf8');
  await syncReceipt(root,db,id);
  assert.equal(fs.readFileSync(path.join(root,'data/applications.md'),'utf8'),advanced);
});
test('canonical status compare-and-set rejects a concurrent advance without changing tracker or history',async t=>{
  const root=scratch(t),tracker=path.join(root,'data/applications.md');
  const original='| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-10-09 | Example | Intern | 4/5 | Interview | - | - | Keep these notes |\n';
  fs.writeFileSync(tracker,original);
  assert.throws(()=>execFileSync(process.execPath,[fileURLToPath(new URL('../set-status.mjs',import.meta.url)),'--row','1','Applied','--expect-status','Evaluated','--json'],{env:{...process.env,CAREER_OPS_ROOT:root,CAREER_OPS_TRACKER:tracker},stdio:'pipe'}));
  assert.equal(fs.readFileSync(tracker,'utf8'),original);
  assert.equal(fs.existsSync(path.join(root,'data/status-log.tsv')),false);
});
test('canonical append-only receipt merge refuses fuzzy identity collisions without overwriting a row',async t=>{
  const root=scratch(t),db=new Ledger(root);t.after(()=>db.close());const id=db.add('https://jobs.lever.co/example/collision');
  const tracker=path.join(root,'data/applications.md');
  const existing='# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-10-09 | Example Company 0 | Senior Product research intern | 3/5 | Interview | - | - | Preserve my interview notes |\n';
  fs.writeFileSync(tracker,existing);
  db.update(id,'ready',{...evaluated(),bundle:path.join(root,'data/autonomous/bundles/fixture'),fingerprints:{cv:'v1'}});db.set('stage','pilot');db.reserve(id,{limit:3,fingerprints:{cv:'v1'}});
  db.receipt(id,{kind:'form-confirmation',reference:'fixture-receipt',at:'2026-10-09T12:00:00Z'});
  assert.deepEqual(await retryTrackerSync(root,db),{synced:0,failed:1});
  assert.equal(db.job(id).state,'confirmed');
  assert.match(db.job(id).payload.trackerSync.error,/append-only merge matched/);
  assert.equal(fs.readFileSync(tracker,'utf8'),existing);
  assert.ok(fs.existsSync(path.join(root,'batch/tracker-additions/autonomous',id,'receipt.tsv')));
});
test('OAuth requests exactly Gmail send/read-only and PKCE',()=>{
  const url=new URL(oauthRequest({client_id:'fixture.apps.googleusercontent.com',client_secret:'fixture'},'http://127.0.0.1:1234/oauth/callback','candidate@example.invalid','state','verifier'));
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.deepEqual(url.searchParams.get('scope').split(' '),GMAIL_SCOPES);
  assert.equal(url.searchParams.get('access_type'),'offline');assert.equal(url.searchParams.get('state'),'state');
});
test('OAuth rejects mismatched callback state and verifies mailbox before storing',async t=>{
  const root=scratch(t),clientPath=path.join(root,'client.json');fs.writeFileSync(clientPath,JSON.stringify({installed:{client_id:'fixture.apps.googleusercontent.com',client_secret:'fixture'}}));
  let saved;
  const result=await connectGmail({root,clientPath,email:'candidate@example.invalid',store:async(_root,_op,value)=>{saved=value;},fetcher:async url=>({ok:true,json:async()=>url.includes('/token')?{access_token:'fixture',refresh_token:'fixture',scope:GMAIL_SCOPES.join(' ')}:{emailAddress:'candidate@example.invalid'}}),onAuthorize:async url=>{
    const u=new URL(url),redirect=u.searchParams.get('redirect_uri');
    assert.equal((await fetch(`${redirect}?state=wrong&code=fixture`)).status,400);
    assert.equal((await fetch(`${redirect}?state=${u.searchParams.get('state')}&code=fixture`)).status,200);
  }});
  assert.equal(result.connected,true);assert.equal(saved.email,'candidate@example.invalid');assert.ok(!fs.existsSync(path.join(root,'token.json')));
});
