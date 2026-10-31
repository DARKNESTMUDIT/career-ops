import { resolveTrackerPathForWrite } from '../path-resolver.mjs';
import { canonicalizeTrackerPath, openTrackerTransaction } from '../tracker-utils.mjs';
import { detectColumns, parseTrackerRow } from '../tracker-parse.mjs';
import { identityKey } from './policy.mjs';
import { verifyMichmerRejectedReceipt, michmerRejectionSnapshot } from './michmer-form.mjs';
import {verifyInternshalaRejectedReceipt,internshalaRejectionSnapshot,verifyInternshalaApplicationReceipt,verifyInternshalaUnsentReceipt,internshalaUnsentSnapshot} from './internshala-application.mjs';
import {adapterFor} from './browser.mjs';

export function rejectedFormProvider(ledger,id) {
  const job=ledger.job(id),attempt=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
  let receipt;try {receipt=JSON.parse(attempt?.receipt);}catch {throw new Error('Invalid rejected form receipt');}
  if(receipt?.kind==='form-not-sent' && receipt.provider==='internshala' && attempt.outcome==='aborted-before-send' && adapterFor(job?.url)==='internshala')return {verify:verifyInternshalaUnsentReceipt,snapshot:internshalaUnsentSnapshot};
  if(receipt?.kind!=='form-rejected')throw new Error('Recognized rejected form receipt required');
  if(receipt.provider==='internshala' && adapterFor(job?.url)==='internshala' && typeof job.payload.internshalaIntentFile==='string')return {verify:verifyInternshalaRejectedReceipt,snapshot:internshalaRejectionSnapshot};
  if(receipt.provider==='michmer' && adapterFor(job?.url)==='michmer' && job.payload.formIntent?.provider==='michmer')return {verify:verifyMichmerRejectedReceipt,snapshot:michmerRejectionSnapshot};
  throw new Error('Unsupported or mismatched rejected form provider');
}

const sentStates = new Set(['Applied','Responded','Interview','Offer','Hired','Rejected','Discarded']);

// Recovery proves existing evidence only. It never sends, retries, repairs a
// tracker row, or grants rollout credit. Hold both writer locks through proof
// and the atomic control/event change.
export async function resolveIntegrityPause(root, ledger) {
  if (!ledger.ownsLock()) throw new Error('Integrity recovery requires the active runner lock');
  const target = canonicalizeTrackerPath(resolveTrackerPathForWrite(root));
  const tracker = await openTrackerTransaction(target);
  try {
    const rejected = new Map();
    for (const attempt of ledger.db.prepare("SELECT * FROM attempts WHERE outcome IN ('rejected','aborted-before-send')").all()) {
      const provider=rejectedFormProvider(ledger,attempt.job_id);
      rejected.set(attempt.job_id,{...(await provider.verify({ledger,id:attempt.job_id})),snapshotCheck:provider.snapshot});
    }
    return ledger.transaction(() => {
      if (!ledger.ownsLock()) throw new Error('Integrity recovery requires the active runner lock');
      const failure = ledger.get('integrityFailure');
      if (!failure || typeof failure !== 'object' || Array.isArray(failure) ||
          typeof failure.reason !== 'string' || !failure.reason.trim() ||
          typeof failure.at !== 'string' || !Number.isFinite(Date.parse(failure.at))) {
        throw new Error('No recognized integrity failure to resolve');
      }
      if (ledger.get('paused') !== true || ledger.get('pauseReason') !== failure.reason) {
        throw new Error('Integrity pause controls are inconsistent');
      }
      const jobs = ledger.jobs();
      if (jobs.some(j => ['submitting','uncertain','confirmed'].includes(j.state))) {
        throw new Error('Unresolved submission or tracker synchronization requires reconciliation');
      }
      const attempts = ledger.db.prepare('SELECT * FROM attempts').all();
      if (jobs.some(j => j.state === 'applied' && !attempts.some(a => a.job_id === j.id))) {
        throw new Error('Applied application lacks a durable submission attempt');
      }
      const content = tracker.read();
      const lines = content.split('\n'), cols = detectColumns(lines);
      if (!cols || ['num','company','role','status','notes'].some(k => !cols[k])) throw new Error('Tracker header is malformed');
      const rows = lines.map(line => parseTrackerRow(line, cols)).filter(Boolean);
      for (const attempt of attempts) {
        if(['rejected','aborted-before-send'].includes(attempt.outcome)) {
          const verified=rejected.get(attempt.job_id),job=jobs.find(j=>j.id===attempt.job_id);
          if(!verified || verified.snapshot!==verified.snapshotCheck(ledger,attempt.job_id) || !['exception','rejected'].includes(job?.state) || job.payload.trackerSync?.verified===true || content.includes(`[autonomous:${attempt.job_id}]`))throw new Error('Rejected submission proof or absence of tracker credit cannot be verified');
          continue;
        }
        if (attempt.outcome !== 'confirmed') throw new Error('Non-confirmed durable attempt requires reconciliation');
        const job = jobs.find(j => j.id === attempt.job_id);
        const sync = job?.payload.trackerSync;
        if (job?.state !== 'applied' || sync?.verified !== true) throw new Error('Attempted application lacks verified tracker synchronization');
        if (sync.path !== target) throw new Error('Verified tracker path differs from canonical tracker');
        let receipt;
        try { receipt = JSON.parse(attempt.receipt); } catch { throw new Error('Invalid durable submission receipt'); }
        if (!receipt || !['form-confirmation','gmail-accepted'].includes(receipt.kind) ||
            typeof receipt.reference !== 'string' || !receipt.reference.trim() || /[\r\n|]/.test(receipt.reference)) {
          throw new Error('Invalid durable submission receipt');
        }
        const adapter=adapterFor(job.url);
        const native=receipt.provider==='internshala' || job.payload.internshalaIntentFile || (receipt.kind==='form-confirmation' && adapter==='internshala');
        if(native) {
          if(receipt.kind!=='form-confirmation' || receipt.provider!=='internshala' || adapter!=='internshala')throw new Error('Native receipt provider or exact role scope mismatch');
          const verified=verifyInternshalaApplicationReceipt({ledger,id:job.id});
          if(JSON.stringify(verified.receipt)!==JSON.stringify(receipt))throw new Error('Native receipt differs from preserved provider proof');
        } else if(receipt.kind==='gmail-accepted') {
          if(receipt.provider && receipt.provider!=='gmail')throw new Error('Unsupported accepted email provider');
        } else if(!['greenhouse','lever','ashby','michmer'].includes(adapter) || (receipt.provider && receipt.provider!==adapter))throw new Error('Unsupported or mismatched accepted form provider');
        const marker = `[autonomous:${job.id}]`;
        const own = rows.filter(row => row.notes.includes(marker));
        if (content.split(marker).length - 1 !== 1 || own.length !== 1) throw new Error('Missing or duplicate autonomous tracker marker');
        const row = own[0];
        if (!job.payload.company || !job.payload.role || row.num !== sync.row ||
            identityKey(row.company,row.role) !== identityKey(job.payload.company,job.payload.role)) {
          throw new Error('Autonomous tracker identity drift');
        }
        if (!sentStates.has(row.status)) throw new Error('Tracker status is not sent-or-later');
        const receiptText = `receipt ${receipt.kind}: ${receipt.reference}`;
        // Canonical synchronization writes one receipt at the end of Notes.
        // Compare the whole suffix so a changed or prefix-matching ID cannot pass.
        const receiptStart = row.notes.indexOf('receipt ');
        if (receiptStart < 0 || row.notes.slice(receiptStart) !== receiptText) throw new Error('Tracker receipt reference drift');
      }
      const verifiedApplications=attempts.filter(attempt=>attempt.outcome==='confirmed').length;
      ledger.event(null,'integrity-recovered',{failure,verifiedApplications,tracker:target});
      ledger.set('integrityFailure',null);
      ledger.set('paused',false);
      ledger.set('pauseReason',null);
      return {resolved:true,verifiedApplications,tracker:target};
    });
  } finally { tracker.close(); }
}
