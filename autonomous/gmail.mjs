import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gmailAccess } from './gmail-auth.mjs';
import { authorizeSubmission } from './rollout.mjs';
import { hash, validateClaims } from './policy.mjs';
import { availabilityDisclosure, productMotivation } from './availability.mjs';

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
  const motivation=productMotivation(context),availability=availabilityDisclosure(context,job);
  return {from:context.profile.candidate.email,to:channel.recipient,subject:`Application: ${job.role}`,body:`Hello,\n\nPlease consider my application for ${job.role} at ${job.company}. My resume is attached.\n${claims.length?'\n'+claims.map(c=>c.text).join('\n')+'\n':''}${motivation?'\n'+motivation+'\n':''}${availability?'\n'+availability+'\n':''}\nThank you,\n${name}`,channel,claims};
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
  const pdf=fs.readFileSync(path.join(job.payload.bundle,'resume.pdf'));
  const createdAt=new Date().toISOString();
  const raw=applicationMime({...draft,pdf,messageId,date:new Date(createdAt)});
  // Store the immutable message and reconciliation key BEFORE recording intent.
  const file=path.join(job.payload.bundle,'application.eml');
  fs.writeFileSync(file,raw,{mode:0o600});
  ledger.update(id,'ready',{emailIntent:{messageId,from:draft.from,to:draft.to,subject:draft.subject,createdAt,bodyHash:hash(draft.body),pdfHash:hash(pdf.toString('base64')),rawHash:hash(raw.toString('base64')),file}});
  ledger.reserve(id,{limit:authorization.limit,fingerprints:job.payload.fingerprints});
  try {
    if(ledger.get('paused'))throw new Error('Paused after email intent');
    const result=await gmailJSON(`${api}/messages/send`,access,fetcher,{method:'POST',body:JSON.stringify({raw:raw.toString('base64url')})});
    if(!providerId(result.id))throw new Error('Gmail returned no valid message receipt');
    const receipt={kind:'gmail-accepted',reference:result.id,messageId,at:new Date().toISOString()};
    ledger.receipt(id,receipt);return receipt;
  }catch(error){
    ledger.update(id,'uncertain',{reasons:[`Email outcome requires reconciliation: ${error.message}`]});
    throw error; // No retry, even for a timeout or API error.
  }
}

const providerId = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const digest = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const unresolved = reason => ({confirmed:false,reason});
function metadata(message, id, intent, requireOriginalId=false) {
  if(message?.id!==id || !Array.isArray(message.labelIds) || !message.labelIds.includes('SENT'))return null;
  const headers=message.payload?.headers;
  if(!Array.isArray(headers) || headers.length>100 || headers.some(h=>typeof h?.name!=='string'||typeof h.value!=='string'||h.value.length>4096))return null;
  const header=name=>headers.filter(h=>h.name.toLowerCase()===name.toLowerCase());
  const exact=(name,value)=>header(name).length===1 && header(name)[0].value===value;
  const messageIds=header('Message-ID');
  if(!exact('From',intent.from)||!exact('To',intent.to)||messageIds.length!==1 || !/^<[^<>\s]{1,998}>$/.test(messageIds[0].value) || (requireOriginalId && messageIds[0].value!==intent.messageId))return null;
  const timestamp=typeof message.internalDate==='string' && /^\d{1,16}$/.test(message.internalDate) ? Number(message.internalDate) : NaN;
  if(!Number.isSafeInteger(timestamp)||timestamp<=0||!Number.isFinite(new Date(timestamp).getTime()))return null;
  return {timestamp,providerMessageId:messageIds[0].value,header};
}
function decodeBytes(data,maximum) {
  if(typeof data!=='string'||data.length>Math.ceil(maximum/3)*4+4 || !/^[A-Za-z0-9_-]*={0,2}$/.test(data) || data.replace(/=+$/,'').length%4===1)return null;
  const bytes=Buffer.from(data,'base64url');
  if(bytes.length>maximum || bytes.toString('base64url')!==data.replace(/=+$/,''))return null;
  return bytes;
}
function decodedSubject(value) {
  if(typeof value!=='string')return null;
  const encoded=/^=\?UTF-8\?B\?([A-Za-z0-9+/]+={0,2})\?=$/i.exec(value);
  if(value.includes('=?')&&!encoded)return null;
  let text=value;
  if(encoded){
    const bytes=Buffer.from(encoded[1],'base64');
    if(bytes.toString('base64')!==encoded[1])return null;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}
  }
  return text.length<=180&&!/[\u0000-\u001f\u007f]/.test(text)?text:null;
}
async function exactContent(message,intent,access,fetcher) {
  const leaves=[];let nodes=0;
  function walk(part,depth=0){
    if(!part||typeof part!=='object'||++nodes>20||depth>5)throw new Error('Unbounded Gmail MIME structure');
    if(part.parts!==undefined){if(!Array.isArray(part.parts)||!part.parts.length)throw new Error('Invalid Gmail MIME parts');for(const child of part.parts)walk(child,depth+1);}
    else leaves.push(part);
  }
  try{walk(message.payload);}catch{return false;}
  if(leaves.length!==2)return false;
  const texts=leaves.filter(p=>p.mimeType==='text/plain'&&!p.filename),pdfs=leaves.filter(p=>p.mimeType==='application/pdf'&&p.filename==='resume.pdf');
  if(texts.length!==1||pdfs.length!==1)return false;
  const textBytes=decodeBytes(texts[0].body?.data,128*1024);
  if(!textBytes)return false;
  let body;try{body=new TextDecoder('utf-8',{fatal:true}).decode(textBytes);}catch{return false;}
  if(hash(body)!==intent.bodyHash)return false;
  const part=pdfs[0];let attachment=part.body;
  if(attachment?.attachmentId!==undefined){
    if(!providerId(attachment.attachmentId))return false;
    attachment=await gmailJSON(`${api}/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.attachmentId)}`,access,fetcher);
  }
  const bytes=decodeBytes(attachment?.data,10*1024*1024);
  if(!bytes || !bytes.subarray(0,5).equals(Buffer.from('%PDF-')))return false;
  return hash(bytes.toString('base64'))===intent.pdfHash;
}

export async function reconcileEmail({root,ledger,id,fetcher=fetch,accessProvider=gmailAccess}) {
  const job=ledger.job(id),intent=job?.payload.emailIntent;
  if(!intent || !['uncertain','submitting','confirmed','applied'].includes(job.state))throw new Error('No email intent to reconcile');
  const attempt=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
  if(!attempt)throw new Error('No durable submission attempt');
  if(!mailbox(intent.from)||!mailbox(intent.to)||!/^<[a-zA-Z0-9-]+@career-ops\.invalid>$/.test(intent.messageId))return unresolved('Invalid durable email intent');
  const access=await accessProvider(root);
  if(access.email?.toLowerCase()!==intent.from.toLowerCase())throw new Error('Reconciliation mailbox mismatch');
  const getMessage=async (messageId,format='metadata')=>gmailJSON(`${api}/messages/${encodeURIComponent(messageId)}?format=${format}&metadataHeaders=Message-ID&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`,access,fetcher);
  const confirm=(message,meta)=>{
    const receipt={kind:'gmail-accepted',reference:message.id,messageId:intent.messageId,providerMessageId:meta.providerMessageId,at:new Date(meta.timestamp).toISOString(),reconciledAt:new Date().toISOString(),reconciled:true};
    ledger.receipt(id,receipt);return {confirmed:true,receipt};
  };
  // An accepted provider ID is stronger than the RFC Message-ID, which Gmail
  // may rewrite. Re-prove its exact SENT identity without moving Applied back.
  if(attempt.outcome==='confirmed'){
    let receipt;try{receipt=JSON.parse(attempt.receipt);}catch{return unresolved('Invalid durable submission receipt');}
    if(receipt?.kind!=='gmail-accepted'||!providerId(receipt.reference))return unresolved('Invalid accepted Gmail identifier');
    const message=await getMessage(receipt.reference),meta=metadata(message,receipt.reference,intent);
    return meta?confirm(message,meta):unresolved('Accepted sent message metadata does not match durable intent');
  }
  const query=new URLSearchParams({q:`in:sent rfc822msgid:${intent.messageId}`,maxResults:'2'});
  const result=await gmailJSON(`${api}/messages?${query}`,access,fetcher);
  if(result.nextPageToken || (result.messages!==undefined&&!Array.isArray(result.messages)))return unresolved('No unique sent-mail receipt; remains unresolved');
  const messages=result.messages||[];
  if(messages.length===1){
    const messageId=messages[0]?.id;if(!providerId(messageId))return unresolved('Sent message identifier unavailable');
    const message=await getMessage(messageId),meta=metadata(message,messageId,intent,true);
    return meta?confirm(message,meta):unresolved('Sent message metadata does not match durable intent');
  }
  if(messages.length!==0)return unresolved('No unique sent-mail receipt; remains unresolved');
  // A rewritten-ID recovery needs the new immutable local evidence. Legacy
  // intents never gain weaker subject-only reconciliation or automatic retries.
  const created=typeof intent.createdAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(intent.createdAt)?Date.parse(intent.createdAt):NaN;
  if(!Number.isSafeInteger(created)||created<=0||new Date(created).toISOString()!==intent.createdAt || decodedSubject(intent.subject)!==intent.subject || !digest(intent.bodyHash)||!digest(intent.pdfHash)||!digest(intent.rawHash))return unresolved('No complete immutable evidence for rewritten Message-ID recovery');
  if(typeof job.payload.bundle!=='string'||typeof intent.file!=='string'||path.resolve(intent.file)!==path.resolve(job.payload.bundle,'application.eml'))return unresolved('Immutable email path does not match bundle');
  try{const stat=fs.statSync(intent.file);if(!stat.isFile()||stat.size>15*1024*1024||hash(fs.readFileSync(intent.file).toString('base64'))!==intent.rawHash)return unresolved('Immutable email evidence changed');}catch{return unresolved('Immutable email evidence unavailable');}
  const end=created+20*60*1000;
  const quoted=value=>`"${value.replace(/["\\]/g,'\\$&')}"`;
  const search=new URLSearchParams({q:`in:sent from:${quoted(intent.from)} to:${quoted(intent.to)} subject:${quoted(intent.subject)} after:${Math.floor(created/1000)} before:${Math.ceil(end/1000)}`,maxResults:'10'});
  const candidates=await gmailJSON(`${api}/messages?${search}`,access,fetcher);
  if(candidates.nextPageToken || (candidates.messages!==undefined&&!Array.isArray(candidates.messages)) || (candidates.messages?.length||0)>10)return unresolved('Bounded rewritten-ID search is ambiguous');
  const listed=candidates.messages||[];
  if(listed.some(item=>!providerId(item?.id))||new Set(listed.map(item=>item.id)).size!==listed.length)return unresolved('Invalid rewritten-ID search identifiers');
  const matches=[];
  for(const item of listed){
    const message=await getMessage(item.id,'full'),meta=metadata(message,item.id,intent);
    if(!meta||meta.timestamp<created||meta.timestamp>end)continue;
    const subject=meta.header('Subject');
    if(subject.length!==1||decodedSubject(subject[0].value)!==intent.subject)continue;
    if(await exactContent(message,intent,access,fetcher))matches.push({message,meta});
  }
  return matches.length===1?confirm(matches[0].message,matches[0].meta):unresolved('No unique exact content match for rewritten Message-ID');
}
