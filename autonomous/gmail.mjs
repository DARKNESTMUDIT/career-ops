import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gmailAccess } from './gmail-auth.mjs';
import { authorizeSubmission } from './rollout.mjs';
import { hash, validateClaims } from './policy.mjs';

const mailbox = value => typeof value==='string' && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value);
const wrapped = bytes => bytes.toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
export function applicationMime({from,to,subject,body,pdf,messageId,date=new Date()}) {
  if(!mailbox(from)||!mailbox(to))throw new Error('One exact sender and recipient required');
  if(typeof subject!=='string'||/[\r\n]/.test(subject)||subject.length>180)throw new Error('Invalid email subject');
  if(!/^<[a-zA-Z0-9-]+@career-ops\.invalid>$/.test(messageId))throw new Error('Invalid application message ID');
  if(!Buffer.isBuffer(pdf)||!pdf.subarray(0,5).equals(Buffer.from('%PDF-'))||pdf.length>10*1024*1024)throw new Error('Invalid resume attachment');
  const boundary=`career-${randomUUID()}`;
  const encodedSubject=`=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  return Buffer.from([
    `From: ${from}`,`To: ${to}`,`Subject: ${encodedSubject}`,`Message-ID: ${messageId}`,`Date: ${date.toUTCString()}`,
    'MIME-Version: 1.0',`Content-Type: multipart/mixed; boundary="${boundary}"`,'',
    `--${boundary}`,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',wrapped(Buffer.from(body)),
    `--${boundary}`,'Content-Type: application/pdf; name="resume.pdf"','Content-Disposition: attachment; filename="resume.pdf"','Content-Transfer-Encoding: base64','',wrapped(pdf),
    `--${boundary}--`,''
  ].join('\r\n'));
}

// Recipient authorization is a reviewed employer-channel record, never model
// output. Mere occurrence of an email address in a scraped page is insufficient.
export function emailDraft(context,job,channel) {
  if(channel?.verified!==true || channel.roleUrl!==job.sourceUrl || channel.company!==job.company || channel.role!==job.role || !mailbox(channel.recipient) || !channel.quote?.includes(channel.recipient) || !job.jd.includes(channel.quote))throw new Error('Verified role-specific email channel required');
  if(channel.postingHash!==hash(job.jd))throw new Error('Email recipient evidence is stale');
  const source=new URL(channel.sourceUrl);
  if(source.protocol!=='https:' || source.hostname!==channel.employerHost)throw new Error('Employer-owned recipient evidence required');
  const claims=job.emailClaims || [];
  if(claims.length)validateClaims(claims,{'cv.md':context.sources['cv.md'],'config/profile.yml':context.sources['config/profile.yml']});
  const name=context.profile.candidate.full_name;
  return {from:context.profile.candidate.email,to:channel.recipient,subject:`Application: ${job.role}`,body:`Hello,\n\nPlease consider my application for ${job.role} at ${job.company}. My resume is attached.\n${claims.length?'\n'+claims.map(c=>c.text).join('\n')+'\n':''}\nThank you,\n${name}`,channel,claims};
}

export function loadEmailChannel(root,job) {
  let data;
  try {data=JSON.parse(fs.readFileSync(path.join(root,'data/autonomous/email-channels.json'),'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!data || typeof data!=='object' || Array.isArray(data))throw new Error('Email channel registry is malformed');
  return data[job.sourceUrl] || null;
}

async function gmailJSON(url,access,fetcher,options={}) {
  const response=await fetcher(url,{...options,headers:{Authorization:`Bearer ${access.token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Gmail request failed (${response.status})`);
  return response.json();
}
const api='https://gmail.googleapis.com/gmail/v1/users/me';
export async function sendApplicationEmail({root,ledger,id,context,channel,fetcher=fetch,accessProvider=gmailAccess}) {
  const authorization=authorizeSubmission(ledger,id,context.fingerprints,'gmail');
  const job=ledger.job(id),draft=emailDraft(context,job.payload,channel);
  const sealed=JSON.parse(fs.readFileSync(path.join(job.payload.bundle,'email.json'),'utf8'));
  if(JSON.stringify(draft)!==JSON.stringify(sealed))throw new Error('Email differs from sealed application bundle');
  const access=await accessProvider(root);
  if(access.email?.toLowerCase()!==draft.from.toLowerCase())throw new Error('Gmail sender mismatch');
  const messageId=`<${randomUUID()}@career-ops.invalid>`;
  const raw=applicationMime({...draft,pdf:fs.readFileSync(path.join(job.payload.bundle,'resume.pdf')),messageId});
  // Store the immutable message and reconciliation key BEFORE recording intent.
  const file=path.join(job.payload.bundle,'application.eml');
  fs.writeFileSync(file,raw,{mode:0o600});
  ledger.update(id,'ready',{emailIntent:{messageId,from:draft.from,to:draft.to,rawHash:hash(raw.toString('base64')),file}});
  ledger.reserve(id,{limit:authorization.limit,fingerprints:job.payload.fingerprints});
  try {
    if(ledger.get('paused'))throw new Error('Paused after email intent');
    const result=await gmailJSON(`${api}/messages/send`,access,fetcher,{method:'POST',body:JSON.stringify({raw:raw.toString('base64url')})});
    if(typeof result.id!=='string'||!result.id)throw new Error('Gmail returned no message receipt');
    const receipt={kind:'gmail-accepted',reference:result.id,messageId,at:new Date().toISOString()};
    ledger.receipt(id,receipt);return receipt;
  }catch(error){
    ledger.update(id,'uncertain',{reasons:[`Email outcome requires reconciliation: ${error.message}`]});
    throw error; // No retry, even for a timeout or API error.
  }
}

export async function reconcileEmail({root,ledger,id,fetcher=fetch,accessProvider=gmailAccess}) {
  const job=ledger.job(id),intent=job?.payload.emailIntent;
  if(!intent || !['uncertain','submitting','confirmed','applied'].includes(job.state))throw new Error('No email intent to reconcile');
  if(!ledger.db.prepare('SELECT id FROM attempts WHERE job_id=?').get(id))throw new Error('No durable submission attempt');
  const access=await accessProvider(root);
  if(access.email?.toLowerCase()!==intent.from.toLowerCase())throw new Error('Reconciliation mailbox mismatch');
  const query=new URLSearchParams({q:`in:sent rfc822msgid:${intent.messageId}`,maxResults:'2'});
  const result=await gmailJSON(`${api}/messages?${query}`,access,fetcher);
  if(result.messages?.length!==1 || result.nextPageToken)return {confirmed:false,reason:'No unique sent-mail receipt; remains unresolved'};
  const listedId=result.messages[0].id;
  if(typeof listedId!=='string' || !listedId)return {confirmed:false,reason:'Sent message identifier unavailable'};
  const message=await gmailJSON(`${api}/messages/${encodeURIComponent(listedId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=From&metadataHeaders=To`,access,fetcher);
  const headers=message.payload?.headers || [];
  const header=name=>headers.filter(h=>h.name.toLowerCase()===name.toLowerCase());
  const exact=(name,value)=>header(name).length===1 && header(name)[0].value===value;
  if(message.id!==listedId || !message.labelIds?.includes('SENT') || !exact('Message-ID',intent.messageId) || !exact('From',intent.from) || !exact('To',intent.to))return {confirmed:false,reason:'Sent message metadata does not match durable intent'};
  // Preserve the provider's message timestamp on delayed recovery. Using the
  // reconciliation clock would shift application dates and follow-up cadence.
  const timestamp=typeof message.internalDate==='string' && /^\d+$/.test(message.internalDate) ? Number(message.internalDate) : NaN;
  if(!Number.isSafeInteger(timestamp) || timestamp<=0 || !Number.isFinite(new Date(timestamp).getTime()))return {confirmed:false,reason:'Sent message timestamp unavailable; remains unresolved'};
  const receipt={kind:'gmail-accepted',reference:message.id,messageId:intent.messageId,at:new Date(timestamp).toISOString(),reconciledAt:new Date().toISOString(),reconciled:true};
  ledger.receipt(id,receipt);return {confirmed:true,receipt};
}
