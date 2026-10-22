import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeUrl } from '../url-key.mjs';
import { identityKey, dayInIndia, currentSchedule } from './policy.mjs';
import { verifyBundle } from './bundle.mjs';

export class Ledger {
  constructor(root) {
    this.dir = path.join(root, 'data', 'autonomous');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(this.dir, 'execution.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS control(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, url TEXT UNIQUE NOT NULL, identity TEXT UNIQUE, track TEXT, state TEXT NOT NULL, payload TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, job_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, day TEXT NOT NULL, outcome TEXT NOT NULL, receipt TEXT);
      CREATE TABLE IF NOT EXISTS runner_lock(id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, pid INTEGER NOT NULL);
      INSERT OR IGNORE INTO control VALUES ('paused','false');
      INSERT OR IGNORE INTO control VALUES ('stage','"dry-run"');
      UPDATE control SET value='"dry-run"' WHERE key='stage' AND value='dry-run';`);
  }
  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get(key) { return JSON.parse(this.db.prepare('SELECT value FROM control WHERE key=?').get(key)?.value ?? 'null'); }
  set(key, value) { this.db.prepare('INSERT INTO control VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  event(id, kind, detail) { this.db.prepare('INSERT INTO events(job_id,kind,detail,at) VALUES (?,?,?,?)').run(id, kind, JSON.stringify(detail), new Date().toISOString()); }
  acquire() {
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM runner_lock').get();
      if (old) {
        let alive = true; try { process.kill(old.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
        if (alive) throw new Error('Another runner is active');
        this.db.prepare('DELETE FROM runner_lock').run();
      }
      const token = randomUUID();
      this.db.prepare('INSERT INTO runner_lock VALUES (1,?,?)').run(token, process.pid);
      this.lockToken = token;
      // A dead process may have sent an application. Never turn this into a retry.
      this.db.prepare("UPDATE jobs SET state='uncertain' WHERE state='submitting'").run();
      return token;
    });
  }
  release(token) { this.db.prepare('DELETE FROM runner_lock WHERE token=?').run(token); if(this.lockToken===token)this.lockToken=null; }
  ownsLock() { const lock=this.db.prepare('SELECT token,pid FROM runner_lock').get(); return !!this.lockToken && lock?.token===this.lockToken && lock.pid===process.pid; }
  add(url) {
    const normalized = normalizeUrl(url);
    const u = new URL(normalized);
    if (u.protocol !== 'https:') throw new Error('Only HTTPS job URLs are accepted');
    const id = randomUUID();
    this.db.prepare('INSERT OR IGNORE INTO jobs VALUES (?,?,NULL,NULL,?,?,?)').run(id, normalized, 'discovered', '{}', new Date().toISOString());
    return this.db.prepare('SELECT id FROM jobs WHERE url=?').get(normalized).id;
  }
  job(id) { const r = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); return r && { ...r, payload: JSON.parse(r.payload) }; }
  jobs() { return this.db.prepare('SELECT * FROM jobs ORDER BY updated,id').all().map(r => ({ ...r, payload: JSON.parse(r.payload) })); }
  update(id, state, payload) {
    const old = this.job(id); if (!old) throw new Error('Unknown application');
    const merged = { ...old.payload, ...payload };
    let identity = old.identity;
    if (merged.company && merged.role) identity = identityKey(merged.company, merged.role);
    this.transaction(() => {
      this.db.prepare('UPDATE jobs SET state=?,identity=?,track=?,payload=?,updated=? WHERE id=?').run(state, identity, merged.track ?? null, JSON.stringify(merged), new Date().toISOString(), id);
      this.event(id, state, { reasons: merged.reasons ?? [] });
    });
  }
  retry(id) {
    const job = this.job(id);
    if (!job || !['exception', 'rejected'].includes(job.state)) throw new Error('Only unsubmitted exceptions/rejections can be re-evaluated');
    if (this.db.prepare('SELECT id FROM attempts WHERE job_id=?').get(id)) throw new Error('Submission attempt exists; reconcile receipt, never retry');
    this.update(id, 'discovered', { reasons: [] });
  }
  resume() {
    if (this.get('integrityFailure')) throw new Error('Resolve the recorded integrity failure before resuming');
    this.set('paused',false); this.set('pauseReason',null);
  }
  reserve(id, { limit, pilotLimit = 3, fingerprints, today = dayInIndia() }) {
    return this.transaction(() => {
      if (this.get('paused')) throw new Error('Runner is paused');
      if (this.get('integrityFailure')) throw new Error('Integrity failure requires resolution');
      const stage = this.get('stage');
      if (!['pilot', 'initial', 'expanded', 'full-scale'].includes(stage)) throw new Error('Dry-run rollout gate');
      const j = this.job(id);
      if (j?.state !== 'ready' || JSON.stringify(j.payload.fingerprints) !== JSON.stringify(fingerprints)) throw new Error('Stale or unready application');
      if (stage === 'full-scale') {
        if (fingerprints?.fullScaleApplications !== true || limit !== null) throw new Error('Full-scale requires explicit policy and null daily limit');
        if (!this.ownsLock()) throw new Error('Submission requires the active runner lock');
        if (j.payload.dryRunComplete !== true || !verifyBundle(j.payload.bundle, fingerprints)) throw new Error('Incomplete or changed bundle');
        if (!currentSchedule(j.payload, {applyWithStatedAvailability:fingerprints.availabilityMode === 'declared'}, today)) throw new Error('Application schedule changed or expired');
      } else {
        const ceiling = stage === 'pilot' ? 3 : stage === 'initial' ? 5 : 10;
        if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid daily limit');
        if (this.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE day=?').get(today).n >= Math.min(limit,ceiling)) throw new Error('Daily limit reached');
        if (stage === 'pilot' && this.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n >= Math.min(pilotLimit,3)) throw new Error('Pilot limit reached');
      }
      if (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('submitting','uncertain')").get().n) throw new Error('Unresolved submission requires reconciliation');
      const attempt = randomUUID();
      // A previously clean day is provisional until all its later actions also
      // finish cleanly. A crash after this intent must not leave clean credit.
      this.set('cleanDays',(this.get('cleanDays') || []).filter(day=>day!==today));
      this.db.prepare('INSERT INTO attempts VALUES (?,?,?,?,NULL)').run(attempt, id, today, 'intent');
      this.db.prepare("UPDATE jobs SET state='submitting' WHERE id=?").run(id);
      this.event(id, 'submission-intent', { attempt, fingerprints });
      return attempt;
    });
  }
  receipt(id, receipt) {
    if (!receipt || !['form-confirmation', 'gmail-accepted'].includes(receipt.kind) || !receipt.reference) throw new Error('Submission evidence required');
    this.transaction(() => {
      const attempt = this.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
      if (!attempt) throw new Error('No recorded submission intent');
      if (attempt.outcome === 'confirmed') {
        if (JSON.parse(attempt.receipt).reference !== receipt.reference) throw new Error('Conflicting receipt requires reconciliation');
        return; // Reconciliation must not move an Applied job backwards.
      }
      this.db.prepare("UPDATE attempts SET outcome='confirmed',receipt=? WHERE job_id=?").run(JSON.stringify(receipt), id);
      this.db.prepare("UPDATE jobs SET state='confirmed' WHERE id=?").run(id);
      this.event(id, 'confirmed', receipt);
    });
  }
  status() {
    const lock = this.db.prepare('SELECT pid FROM runner_lock').get();
    let active = lock ?? null;
    if (lock) { try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') active = null; } }
    return { paused: this.get('paused'), pauseReason: this.get('pauseReason'), lastRunError: this.get('lastRunError'), stage: this.get('stage'), rollout:this.get('rollout'), gmail:this.get('gmailConnection'), active, todayAttempts: this.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE day=?').get(dayInIndia()).n, jobs: this.jobs(), attempts: this.db.prepare('SELECT * FROM attempts').all() };
  }
}
