import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveTrackerPath, resolveTrackerPathForWrite } from '../path-resolver.mjs';
import { openTrackerTransaction, cell, canonicalizeTrackerPath } from '../tracker-utils.mjs';
import { detectColumns, parseTrackerRow } from '../tracker-parse.mjs';
import { identityKey, dayInIndia } from './policy.mjs';

const exec = promisify(execFile);
const header = '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n';
const marker = id => `[autonomous:${id}]`;
const sentStates = new Set(['Applied','Responded','Interview','Offer','Hired','Rejected','Discarded']);

// Add rows only through the canonical TSV merger. Keep each receipt's additions
// isolated so synchronizing it cannot consume unrelated pending batch work.
// Existing rows transition through set-status.mjs and its lifecycle hooks.
export async function syncReceipt(root, ledger, id, {setStatus}={}) {
  const job=ledger.job(id);
  const attempt=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
  if(!job || !['confirmed','applied'].includes(job.state) || attempt?.outcome!=='confirmed')throw new Error('Confirmed receipt required before tracker synchronization');
  const receipt=JSON.parse(attempt.receipt || 'null');
  if(!receipt?.reference || !['form-confirmation','gmail-accepted'].includes(receipt.kind))throw new Error('Invalid submission receipt');
  const target=canonicalizeTrackerPath(resolveTrackerPathForWrite(root)), reading=resolveTrackerPath(root);
  // A legacy tracker must not be silently forked while another core writer is
  // using it. Surface migration as a distinct task, without losing its rows.
  if(reading!==target && fs.existsSync(reading))throw new Error('Legacy tracker requires canonical migration before synchronization');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const tx=await openTrackerTransaction(target);
  let num, addition;
  try {
    let content;
    try {content=tx.read();}catch(e){if(e.code!=='ENOENT')throw e;content=header;tx.replace(header);}
    const lines=content.split('\n'),cols=detectColumns(lines);
    if(!cols || ['num','company','role','status','notes'].some(k=>!cols[k]))throw new Error('Tracker header is malformed');
    const rows=lines.map(l=>parseTrackerRow(l,cols)).filter(Boolean);
    const own=rows.filter(r=>r.notes.includes(marker(id)));
    if(own.length>1)throw new Error('Duplicate tracker evidence markers require reconciliation');
    if(own.length) {
      if(identityKey(own[0].company,own[0].role)!==identityKey(job.payload.company,job.payload.role))throw new Error('Tracker evidence marker belongs to a different role');
      num=own[0].num;
    } else {
      if(rows.some(r=>identityKey(r.company,r.role)===identityKey(job.payload.company,job.payload.role)))throw new Error('Existing tracker identity requires reconciliation; refusing overwrite');
      num=Math.max(0,...rows.map(r=>r.num))+1;
      const fields=[num,dayInIndia(new Date(receipt.at || Date.now())),job.payload.company,job.payload.role,'Evaluated',`${job.payload.fit}/5`,path.relative(path.dirname(target),path.join(job.payload.bundle,'resume.pdf')),'-',`${marker(id)} ${job.url}; receipt ${receipt.kind}: ${receipt.reference}`,job.url];
      addition='#\tDate\tCompany\tRole\tStatus\tScore\tPDF\tReport\tNotes\tURL\n'+fields.map(value=>cell(String(value)).replace(/[\t\r\n]+/g,' ')).join('\t')+'\n';
    }
  } finally {tx.close();}
  if(addition) {
    const additions=path.join(root,'batch/tracker-additions/autonomous',id);
    fs.mkdirSync(additions,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(additions,'receipt.tsv'),addition,{mode:0o600});
    await exec(process.execPath,[fileURLToPath(new URL('../merge-tracker.mjs',import.meta.url)),'--append-only'],{env:{...process.env,CAREER_OPS_ROOT:root,CAREER_OPS_TRACKER:target,CAREER_OPS_ADDITIONS:additions},timeout:65000,maxBuffer:100000});
    const merged=fs.readFileSync(target,'utf8').split('\n'),mergedCols=detectColumns(merged);
    const own=merged.map(line=>parseTrackerRow(line,mergedCols)).filter(row=>row?.notes.includes(marker(id)));
    if(own.length!==1 || identityKey(own[0].company,own[0].role)!==identityKey(job.payload.company,job.payload.role))throw new Error('Canonical merge did not preserve receipt identity');
    num=own[0].num;
  }
  const transition=setStatus || (async()=>{
    await exec(process.execPath,[fileURLToPath(new URL('../set-status.mjs',import.meta.url)),'--row',String(num),'Applied','--expect-status','Evaluated','--on',dayInIndia(new Date(receipt.at || Date.now())),'--json'],{env:{...process.env,CAREER_OPS_ROOT:root,CAREER_OPS_TRACKER:target},timeout:65000,maxBuffer:100000});
  });
  const before=fs.readFileSync(target,'utf8').split('\n'),beforeCols=detectColumns(before);
  const current=before.map(line=>parseTrackerRow(line,beforeCols)).find(row=>row?.num===num);
  if(!current?.notes.includes(marker(id)))throw new Error('Tracker receipt identity changed before status transition');
  // A replay must never move a recruiter response or interview back to Applied.
  // The canonical writer checks Evaluated atomically for concurrent advances.
  if(!sentStates.has(current.status))await transition(num,target);
  const final=fs.readFileSync(target,'utf8').split('\n'),cols=detectColumns(final);
  const row=final.map(l=>parseTrackerRow(l,cols)).find(r=>r?.num===num);
  if(!sentStates.has(row?.status)||!row.notes.includes(marker(id)))throw new Error('Tracker write could not be verified');
  ledger.update(id,'applied',{trackerSync:{verified:true,row:num,path:target,at:new Date().toISOString()},reasons:[]});
  return {row:num,path:target};
}

export async function retryTrackerSync(root,ledger,options) {
  const result={synced:0,failed:0};
  for(const job of ledger.jobs().filter(j=>j.state==='confirmed')) {
    try {await syncReceipt(root,ledger,job.id,options);result.synced++;}
    catch(e){ledger.update(job.id,'confirmed',{trackerSync:{verified:false,error:e.message},reasons:[`Receipt saved; tracker sync pending: ${e.message}`]});result.failed++;}
  }
  return result;
}
