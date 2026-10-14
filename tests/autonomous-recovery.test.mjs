import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../autonomous/ledger.mjs';
import { integrityPause } from '../autonomous/rollout.mjs';
import { resolveIntegrityPause } from '../autonomous/recovery.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'autonomous-recovery-')));
  const ledger = new Ledger(root), token = ledger.acquire();
  t.after(() => { ledger.release(ledger.lockToken || token); ledger.close(); fs.rmSync(root,{recursive:true,force:true}); });
  const tracker = path.join(root,'data/applications.md');
  const id = ledger.add('https://jobs.lever.co/example/recovery');
  ledger.update(id,'ready',{company:'Example',role:'Intern',fingerprints:{cv:'fixture'}});
  ledger.set('stage','pilot'); ledger.reserve(id,{limit:3,fingerprints:{cv:'fixture'}});
  ledger.receipt(id,{kind:'form-confirmation',reference:'receipt-123',at:'2026-10-14T00:00:00Z'});
  ledger.update(id,'applied',{trackerSync:{verified:true,row:1,path:tracker}});
  const header = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n';
  const row = `| 1 | 2026-10-14 | Example | Intern | 4/5 | Applied | - | - | [autonomous:${id}] https://jobs.lever.co/example/recovery; receipt form-confirmation: receipt-123 |\n`;
  fs.writeFileSync(tracker,header+row);
  ledger.set('cleanDays',['2026-10-13']); integrityPause(ledger,'Fixture failure');
  return {root,ledger,token,tracker,id,header,row};
}
function snapshot(ledger) {
  return {jobs:ledger.jobs(),attempts:ledger.db.prepare('SELECT * FROM attempts').all(),failure:ledger.get('integrityFailure'),paused:ledger.get('paused'),reason:ledger.get('pauseReason'),clean:ledger.get('cleanDays')};
}
test('recovery verifies an advanced canonical tracker without modifying submission evidence or restoring credit',async t => {
  const f = fixture(t), before = snapshot(f.ledger);
  fs.writeFileSync(f.tracker,f.header+f.row.replace('| Applied |','| Interview |'));
  const content = fs.readFileSync(f.tracker,'utf8');
  assert.deepEqual(await resolveIntegrityPause(f.root,f.ledger),{resolved:true,verifiedApplications:1,tracker:f.tracker});
  assert.equal(f.ledger.get('integrityFailure'),null); assert.equal(f.ledger.get('paused'),false); assert.equal(f.ledger.get('pauseReason'),null);
  assert.deepEqual(f.ledger.jobs(),before.jobs); assert.deepEqual(f.ledger.db.prepare('SELECT * FROM attempts').all(),before.attempts);
  assert.deepEqual(f.ledger.get('cleanDays'),[]); assert.equal(fs.readFileSync(f.tracker,'utf8'),content);
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='integrity-recovered'").get().n,1);
});
for (const state of ['submitting','uncertain','confirmed']) test(`recovery refuses ${state} applications`,async t => {
  const f = fixture(t); f.ledger.update(f.id,state,{}); const before = snapshot(f.ledger);
  await assert.rejects(resolveIntegrityPause(f.root,f.ledger),/Unresolved/); assert.deepEqual(snapshot(f.ledger),before);
});
test('recovery refuses an unresolved durable attempt even when the job looks applied',async t => {
  const f = fixture(t); f.ledger.db.prepare("UPDATE attempts SET outcome='intent'").run(); const before = snapshot(f.ledger);
  await assert.rejects(resolveIntegrityPause(f.root,f.ledger),/Non-confirmed/); assert.deepEqual(snapshot(f.ledger),before);
});
for (const [name,change,error] of [
  ['missing tracker',f => fs.unlinkSync(f.tracker),/ENOENT/],
  ['missing marker',f => fs.writeFileSync(f.tracker,f.header),/marker/],
  ['duplicate marker',f => fs.writeFileSync(f.tracker,f.header+f.row+f.row),/marker/],
  ['identity drift',f => fs.writeFileSync(f.tracker,f.header+f.row.replace('| Example |','| Other |')),/identity drift/],
  ['status drift',f => fs.writeFileSync(f.tracker,f.header+f.row.replace('| Applied |','| Evaluated |')),/sent-or-later/],
  ['receipt drift',f => fs.writeFileSync(f.tracker,f.header+f.row.replace('receipt-123','receipt-1234')),/receipt reference drift/],
  ['invalid receipt',f => f.ledger.db.prepare("UPDATE attempts SET receipt='not-json'").run(),/Invalid durable/],
  ['orphan durable attempt',f => f.ledger.db.prepare('UPDATE attempts SET job_id=?').run('missing-job'),/durable submission attempt/],
  ['applied job without attempt',f => f.ledger.db.prepare('DELETE FROM attempts').run(),/durable submission attempt/],
  ['attempted job not applied',f => f.ledger.update(f.id,'exception',{}),/verified tracker/],
  ['unverified synchronization',f => f.ledger.update(f.id,'applied',{trackerSync:{verified:false}}),/verified tracker/],
  ['canonical path drift',f => f.ledger.update(f.id,'applied',{trackerSync:{verified:true,row:1,path:f.tracker+'.other'}}),/canonical tracker/],
]) test(`recovery refuses ${name} and preserves pause/evidence`,async t => {
  const f = fixture(t); change(f); const before = snapshot(f.ledger);
  await assert.rejects(resolveIntegrityPause(f.root,f.ledger),error); assert.deepEqual(snapshot(f.ledger),before);
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='integrity-recovered'").get().n,0);
});
test('recovery requires its owned runner lock and a recognized integrity pause',async t => {
  const f = fixture(t); f.ledger.release(f.token);
  await assert.rejects(resolveIntegrityPause(f.root,f.ledger),/active runner lock/);
  f.ledger.acquire();
  for (const failure of [null,true,{reason:'unknown'}, {reason:'',at:new Date().toISOString()}]) {
    f.ledger.set('integrityFailure',failure);
    await assert.rejects(resolveIntegrityPause(f.root,f.ledger),/recognized integrity failure/);
  }
  f.ledger.set('integrityFailure',{reason:'Fixture failure',at:new Date().toISOString()});
  f.ledger.set('pauseReason','Different pause');
  await assert.rejects(resolveIntegrityPause(f.root,f.ledger),/inconsistent/);
});
test('zero-attempt recognized pause recovers against a readable valid canonical tracker',async t => {
  const f = fixture(t);
  f.ledger.db.prepare('DELETE FROM attempts').run(); f.ledger.update(f.id,'exception',{});
  fs.writeFileSync(f.tracker,f.header);
  const before = snapshot(f.ledger);
  assert.deepEqual(await resolveIntegrityPause(f.root,f.ledger),{resolved:true,verifiedApplications:0,tracker:f.tracker});
  assert.equal(f.ledger.get('paused'),false); assert.equal(f.ledger.get('integrityFailure'),null);
  assert.deepEqual(f.ledger.jobs(),before.jobs); assert.deepEqual(f.ledger.get('cleanDays'),[]);
  assert.equal(f.ledger.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n,0);
});
for (const unresolved of [false,true]) test(`isolated recover CLI ${unresolved ? 'preserves an unresolved pause' : 'clears a verified pause'} without sending`,t => {
  const f = fixture(t);
  if (unresolved) f.ledger.update(f.id,'uncertain',{});
  const before = snapshot(f.ledger);
  f.ledger.release(f.token);
  const guard = path.join(f.root,'network-guard.mjs');
  fs.writeFileSync(guard,"globalThis.fetch = () => { throw new Error('Network access forbidden in recovery fixture'); };\n");
  const result = spawnSync(process.execPath,['--import',guard,fileURLToPath(new URL('../autonomous-runner.mjs',import.meta.url)),'recover'],{
    cwd:f.root,env:{...process.env,CAREER_OPS_ROOT:f.root,CAREER_OPS_DATA_DIR:f.root,CAREER_OPS_TRACKER:f.tracker},encoding:'utf8',timeout:10000,
  });
  assert.equal(result.error,undefined);
  assert.equal(result.status,unresolved ? 1 : 0,result.stderr);
  if (unresolved) {
    assert.match(result.stderr,/Unresolved/); assert.deepEqual(snapshot(f.ledger),before);
  } else {
    assert.equal(JSON.parse(result.stdout).resolved,true);
    assert.equal(f.ledger.get('paused'),false); assert.equal(f.ledger.get('integrityFailure'),null);
  }
  assert.deepEqual(f.ledger.jobs(),before.jobs);
  assert.deepEqual(f.ledger.db.prepare('SELECT * FROM attempts').all(),before.attempts);
  assert.equal(f.ledger.ownsLock(),false);
  assert.equal(f.ledger.db.prepare('SELECT COUNT(*) AS n FROM runner_lock').get().n,0);
});
