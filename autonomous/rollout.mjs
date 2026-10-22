import { dayInIndia, currentSchedule } from './policy.mjs';
import { verifyBundle } from './bundle.mjs';

// Validation is an explicit engineering gate, independent of evaluations.
// Gmail dispatch/reconciliation, canonical tracker sync and integrity recovery
// are certified by autonomous-gmail-integration.test.mjs. Form acceptance and
// reconciliation remain uncertified; no stage counter can enable them.
export const ADAPTER_VALIDATION = Object.freeze({ greenhouse:false, lever:false, ashby:false, gmail:true, michmer:true });
export function rolloutStatus(ledger, fingerprints, today = dayInIndia()) {
  const jobs = ledger.jobs();
  const current = j => Object.entries(fingerprints || {}).every(([k,v]) => j.payload.fingerprints?.[k] === v);
  const schedulePolicy={applyWithStatedAvailability:fingerprints?.availabilityMode==='declared'};
  const dry = jobs.filter(j => ['remote','summer'].includes(j.track) && ['ready','confirmed','applied'].includes(j.state) && j.payload.dryRunComplete === true && current(j) && currentSchedule(j.payload,schedulePolicy,today) && verifyBundle(j.payload.bundle, j.payload.fingerprints));
  const tracks = [...new Set(dry.map(j => j.track))];
  const attempts = ledger.db.prepare('SELECT * FROM attempts').all();
  const verified = attempts.filter(a => a.outcome === 'confirmed' && jobs.some(j => j.id === a.job_id && j.state === 'applied' && j.payload.trackerSync?.verified === true));
  const unresolved = jobs.filter(j => ['submitting','uncertain'].includes(j.state)).length;
  const clean = ledger.get('cleanDays') || [];
  let consecutive = 0;
  // Only completed calendar days count. A run must have operated that day;
  // elapsed wall time alone cannot promote the quota.
  const cursor = new Date(`${today}T00:00:00Z`);
  for (let i=0;i<7;i++) { cursor.setUTCDate(cursor.getUTCDate()-1); if (!clean.includes(cursor.toISOString().slice(0,10))) break; consecutive++; }
  // Live-start authorization no longer waits for a batch or the other track.
  // Each application still needs its own complete current verified bundle.
  const dryPassed = dry.length >= 1 || verified.length > 0;
  let stage = !dryPassed ? 'dry-run' : fingerprints?.fullScaleApplications === true ? 'full-scale' : verified.length < 3 ? 'pilot' : verified.length >= 10 && consecutive >= 7 ? 'expanded' : 'initial';
  const reasons = [];
  if (!dryPassed) reasons.push('One complete, current verified application required');
  if (unresolved) reasons.push('Submission outcome needs reconciliation');
  if (ledger.get('integrityFailure')) reasons.push('Integrity failure requires resolution');
  if (ledger.get('paused')) reasons.push('Runner is paused');
  // null is an explicit absence of a daily quota, and survives JSON storage.
  const limit = stage === 'full-scale' ? null : stage === 'dry-run' ? 0 : stage === 'pilot' ? 3 : stage === 'initial' ? 5 : 10;
  return { stage, limit, completeDryRuns:dry.length, tracks, verifiedApplications:verified.length, consecutiveCleanDays:consecutive, unresolved, reasons, adapterValidation:ADAPTER_VALIDATION, todayAttempts:attempts.filter(a=>a.day===today).length, totalAttempts:attempts.length };
}

export function authorizeSubmission(ledger, id, fingerprints, adapter, today = dayInIndia()) {
  const state = rolloutStatus(ledger, fingerprints, today);
  if (!ADAPTER_VALIDATION[adapter]) throw new Error(`Live adapter validation pending: ${adapter}`);
  if (!ledger.ownsLock()) throw new Error('Submission requires the active runner lock');
  if (state.reasons.length) throw new Error(state.reasons.join('; '));
  if (state.stage === 'pilot' && state.totalAttempts >= 3) throw new Error('Pilot receipts and tracker rows must be verified');
  if (state.limit !== null && state.todayAttempts >= state.limit) throw new Error('Daily submission limit reached');
  const job = ledger.job(id);
  if (job?.state !== 'ready' || !verifyBundle(job.payload.bundle, job.payload.fingerprints)) throw new Error('Incomplete or changed bundle');
  if (!Object.entries(fingerprints || {}).every(([k,v])=>job.payload.fingerprints?.[k]===v)) throw new Error('Candidate or policy changed');
  if (job.payload.deadline < today) throw new Error('Application deadline passed');
  if (job.payload.start < today) throw new Error('Internship start date passed');
  ledger.set('stage',state.stage);
  return state;
}

export function integrityPause(ledger, reason) {
  ledger.set('integrityFailure',{reason,at:new Date().toISOString()});
  ledger.set('paused',true); ledger.set('pauseReason',reason);
  ledger.set('cleanDays',[]);
  ledger.event(null,'integrity-failure',{reason});
}

export function recordOperatingDay(ledger, today = dayInIndia()) {
  // Dry-run-only activity cannot establish a clean live operating day.
  const jobs=ledger.jobs();
  ledger.set('cleanDays',(ledger.get('cleanDays') || []).filter(day=>day!==today));
  if (ledger.get('integrityFailure') || jobs.some(j=>['uncertain','submitting','confirmed'].includes(j.state))) return;
  const attempts=ledger.db.prepare('SELECT * FROM attempts WHERE day=?').all(today);
  if (!attempts.length || attempts.some(a=>a.outcome !== 'confirmed' || !jobs.some(j=>j.id===a.job_id && j.state==='applied' && j.payload.trackerSync?.verified===true))) return;
  ledger.set('cleanDays',[...new Set([...(ledger.get('cleanDays') || []),today])].sort().slice(-60));
}

export function pendingWork(jobs, rankFresh = jobs=>jobs) {
  // Alternate new/preparation work with freshness checks. A full queue of
  // current bundles must not consume every capture slot on every run.
  const fresh=rankFresh(prioritize(jobs.filter(j=>j.state!=='ready')));
  const ready=prioritize(jobs.filter(j=>j.state==='ready'));
  const ordered=[];
  while(fresh.length || ready.length) {
    if(fresh.length)ordered.push(fresh.shift());
    if(ready.length)ordered.push(ready.shift());
  }
  return ordered;
}

export function prioritize(jobs) {
  const unenriched = job => job.state === 'discovered' && !job.payload.deadline && job.payload.fit == null;
  const sorted = [...jobs].sort((a,b) => {
    const rank = (a.payload.deadline || '9999').localeCompare(b.payload.deadline || '9999') || (b.payload.fit || 0)-(a.payload.fit || 0);
    if (rank) return rank;
    // Use a fixed category before choosing timestamp direction, preserving a
    // transitive order when prepared and unenriched entries share rank keys.
    const rawA = unenriched(a), rawB = unenriched(b);
    if (rawA !== rawB) return rawA ? 1 : -1;
    return (rawA ? b.updated.localeCompare(a.updated) : a.updated.localeCompare(b.updated)) || String(a.id ?? '').localeCompare(String(b.id ?? ''));
  });
  // Alternate known tracks without starving unclassified discovery. Within each
  // track retain deadline then fit ordering.
  const queues = ['remote','summer',null].map(track=>sorted.filter(j=>(j.track || null)===track));
  const result=[];
  while (queues.some(q=>q.length)) for (const q of queues) if(q.length) result.push(q.shift());
  return result;
}
