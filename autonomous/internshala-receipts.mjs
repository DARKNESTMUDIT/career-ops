import {internshalaNativeContract,nativeQuestionSchema} from './internshala-contracts.mjs';
import { createHash } from 'node:crypto';
import {INTERNSHALA_HISTORY_VERSION,verifyNextReceipt} from './internshala-history.mjs';
export {assertInternshalaHistoryBefore,internshalaHistoryDigest} from './internshala-history.mjs';

// Deliberately unregistered. This module checks an existing native-browser
// capture; it cannot navigate, submit, retry, or award an application receipt.
export const INTERNSHALA_SUBMIT_CONTRACT = Object.freeze({
  script: 'application_common.1779969852.js',
  sha256: '0e47e19c4ceef6a0b4197eab6d53537eef1275c35781b322292f1904bce1f200',
  form: '#application-form',
  response: 'HTTP 2xx JSON with success === true',
  receiptCertified: false,
});

const sha256 = value => createHash('sha256').update(value).digest('hex');
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function internshipIdentity(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    const match = /^\/internship\/detail\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(u.pathname);
    if (u.protocol !== 'https:' || u.hostname !== 'internshala.com' || u.port || u.username || u.password || u.search || u.hash || !match) return null;
    return { sourceUrl:u.href, slug:match[1], submitUrl:`https://internshala.com/application/submit/${match[1]}` };
  } catch { return null; }
}

// Canonical digest binds the expected values to an already durable intent.
// The caller must supply the independently stored digest; this function does
// not create an intent or assert that one has been persisted.
export function intentDigest(intent) {
  const serialized=JSON.stringify(intent);
  return typeof serialized === 'string' ? sha256(Buffer.from(serialized)) : null;
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

function multipartParts(bytes, boundary) {
  if (!boundary || !/^[\x21-\x7e]{1,70}$/.test(boundary)) return null;
  const text = bytes.toString('latin1');
  const marker = `--${boundary}`;
  if (!text.startsWith(marker+'\r\n') || !text.endsWith(`\r\n${marker}--\r\n`)) return null;
  const segments = text.slice(marker.length+2,-(`\r\n${marker}--\r\n`).length).split(`\r\n${marker}\r\n`);
  const fields = new Map();
  for (const segment of segments) {
    const split = segment.indexOf('\r\n\r\n');
    if (split < 0) return null;
    const headers = segment.slice(0,split);
    const disposition = /^Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?$/mi.exec(headers);
    if (!disposition || /\r|\n/.test(disposition[1])) return null;
    const payload = Buffer.from(segment.slice(split+4).replace(/\r\n$/, ''),'latin1');
    const parts=fields.get(disposition[1]) || [];
    parts.push({ filename:disposition[2] ?? null, bytes:payload, headers });
    fields.set(disposition[1],parts);
  }
  return fields;
}

function responseJson(entry) {
  const content = entry?.response?.content;
  if (!content || typeof content.text !== 'string') return null;
  const bytes = content.encoding === 'base64' ? decodeBase64(content.text) : Buffer.from(content.text);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
}

function plainHtml(value) {
  return value.replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&#39;|&apos;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
}

function historyReceipt(history, intent, entry) {
  if (!history || typeof history !== 'object') return null;
  if(history.version!==undefined)return history.version===INTERNSHALA_HISTORY_VERSION ? verifyNextReceipt(history.before,history.after,intent,entry):null;
  try {
    const page=new URL(history.pageUrl);
    if(page.protocol!=='https:' || page.hostname!=='internshala.com' || page.pathname!=='/student/applications/' || page.username || page.password || page.port) return null;
  } catch { return null; }
  if(typeof history.beforePageHtml!=='string' || typeof history.afterPageHtml!=='string' || typeof history.cardOuterHTML!=='string' || history.beforePageHtml.length>2_000_000 || history.afterPageHtml.length>2_000_000 || history.cardOuterHTML.length>100_000) return null;
  if(!hex64(history.beforePageSha256) || sha256(Buffer.from(history.beforePageHtml))!==history.beforePageSha256) return null;
  if(!hex64(history.afterPageSha256) || sha256(Buffer.from(history.afterPageHtml))!==history.afterPageSha256) return null;
  if(!hex64(history.cardSha256) || sha256(Buffer.from(history.cardOuterHTML))!==history.cardSha256) return null;
  if(!hex64(history.screenshotSha256)) return null;
  const before=Date.parse(history.beforeObservedAt), posted=Date.parse(entry.startedDateTime), after=Date.parse(history.observedAt);
  if(!Number.isFinite(before) || !Number.isFinite(posted) || !Number.isFinite(after) || !(before<posted && posted<after)) return null;
  if(history.beforePageHtml.includes(intent.sourceUrl)) return null;
  if(history.afterPageHtml.split(history.cardOuterHTML).length!==2) return null;
  const anchors=[...history.cardOuterHTML.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(m=>({
    href:/\bhref\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1],text:plainHtml(m[2]),
  }));
  const sourceAnchors=anchors.filter(a=>a.href===intent.sourceUrl);
  const viewAnchors=anchors.filter(a=>/^https:\/\/internshala\.com\/application\/view\/\d+(?:\?referral=dashboard)?$/.test(a.href??''));
  if(sourceAnchors.length!==1 || viewAnchors.length!==1) return null;
  if(![sourceAnchors[0],viewAnchors[0]].every(a=>a.text.includes(intent.role) && a.text.includes(intent.company))) return null;
  if(!/\bApplied on\s+\d{1,2}\s+[A-Z][a-z]{2}'\s*\d{2}\b/.test(plainHtml(history.cardOuterHTML))) return null;
  const id=/\/application\/view\/(\d+)/.exec(viewAnchors[0].href)?.[1];
  return id ? {applicationId:id,sourceUrl:intent.sourceUrl,cardSha256:history.cardSha256,screenshotSha256:history.screenshotSha256} : null;
}

function checkIntent(intent, sealedDigest, reasons) {
  const identity = internshipIdentity(intent?.sourceUrl);
  if (!identity) reasons.push('invalid_source_url');
  if (!hex64(sealedDigest) || intentDigest(intent) !== sealedDigest) reasons.push('intent_seal_mismatch');
  if (intent?.state !== 'active' || !intent?.durableReference || intent?.reservedBeforeFirstPII!==true) reasons.push('inactive_or_unproven_intent');
  if (!intent?.jobId || typeof intent.jobId !== 'string' || !intent?.jobIdField || typeof intent.jobIdField !== 'string') reasons.push('missing_job_identity');
  if (!intent?.company || !intent?.role || !intent?.approvedSources || !Array.isArray(intent.approvedSources) || !intent?.sourceProofs || typeof intent.sourceProofs !== 'object') reasons.push('missing_role_or_sources');
  if (!intent?.fields || typeof intent.fields !== 'object' || Array.isArray(intent.fields) || Object.keys(intent.fields).length === 0) reasons.push('missing_expected_fields');
  else for (const [key, field] of Object.entries(intent.fields)) {
    if (!key || !field || typeof field.value !== 'string' || field.value.trim() === '' || !intent.approvedSources?.includes(field.source) || !hex64(field.sourceSha256) || intent.sourceProofs?.[field.source]?.sha256 !== field.sourceSha256) reasons.push('unapproved_or_missing_field');
  }
  const pdf = intent?.pdf;
  if (!pdf || !pdf.fieldName || !pdf.filename || !Number.isSafeInteger(pdf.size) || pdf.size <= 0 || !hex64(pdf.sha256) || pdf.frozenBeforeIntent !== true) reasons.push('missing_frozen_pdf_proof');
  if(intent?.nativeForm || intent?.protocolFields) {
    const native=intent.nativeForm,protocol=intent.protocolFields;
    const contract=internshalaNativeContract(intent.sourceUrl),slug=contract?.slug;
    if(!contract || native?.contract!==contract.id || native.pdfPartCount!==2 || native.scriptArtifact?.sha256!==INTERNSHALA_SUBMIT_CONTRACT.sha256 || !hex64(native.formArtifact?.sha256) || !native.formArtifact?.path || !native.scriptArtifact?.path || identity?.slug!==slug || intent.jobId!==slug || intent.jobIdField!=='internshipId' || intent.answersReviewed!==true || pdf?.fieldName!=='custom_resume')reasons.push('unproven_native_form_contract');
    if(contract?.questions.length && (JSON.stringify(native?.questionSchema)!==JSON.stringify(nativeQuestionSchema(contract)) || intent.company!==contract.company || intent.role!==contract.role))reasons.push('unproven_native_questions_or_identity');
    for(const question of contract?.questions ?? [])if(question.options && (intent.fields?.[question.name]?.mapping!==question.mapping || !question.options.some(option=>!option.disabled && option.value===intent.fields?.[question.name]?.value)))reasons.push('unproven_typed_answer_mapping');
    const fixed={source:'easy_apply_modal',is_sequential_apply_flow:'',sequential_apply_referral:'similar_internships',last_applied_application_id:'',last_applied_job_profile:'',current_job_profile:contract?.role,prefilled_custom_resume:''};
    if(!protocol || typeof protocol!=='object' || Array.isArray(protocol))reasons.push('invalid_protocol_fields');
    else {
      for(const [name,field] of Object.entries(protocol)) {
        const hidden=Object.hasOwn(fixed,name) || name==='csrf_test_name';
        const valid=hidden ? field?.kind==='observed-hidden' && (name==='csrf_test_name' ? typeof field.value==='string' && field.value.length>0 : field.value===fixed[name]) : name==='submit' ? field?.kind==='observed-submit' && field.value==='Submit' : ['last_working_date','confirm_availability_textarea'].includes(name) && field?.kind==='inactive-empty' && field.value==='';
        if(!valid || Object.hasOwn(intent.fields ?? {},name) || name===intent.jobIdField || name===pdf?.fieldName)reasons.push('invalid_protocol_fields');
      }
      if([...Object.keys(fixed),'csrf_test_name','submit'].some(name=>!Object.hasOwn(protocol,name)))reasons.push('missing_protocol_fields');
      const availability=intent.fields?.confirm_availability?.value;
      const required=[...(contract?.questions ?? []).map(question=>question.name),'confirm_availability',...(availability==='no'?['confirm_availability_textarea']:availability==='serving-notice'?['last_working_date']:availability==='to-serve-notice'?['notice_period']:[])];
      if(!['yes','no','serving-notice','to-serve-notice'].includes(availability) || Object.keys(intent.fields ?? {}).length!==required.length || required.some(name=>!Object.hasOwn(intent.fields ?? {},name)) || ['last_working_date','confirm_availability_textarea'].some(name=>!Object.hasOwn(intent.fields ?? {},name) && !Object.hasOwn(protocol,name)))reasons.push('native_required_answers_missing');
    }
  }
  return identity;
}

// HAR exports commonly omit binary multipart bytes. In that case the result
// remains held even if the response says success. A bodyBase64 extension must
// be captured from the actual native request boundary, not reconstructed from
// planned answers or a local PDF after submission.
export function inspectInternshalaReceipt({intent, sealedIntentSha256, har, history} = {}) {
  const reasons = [];
  const identity = checkIntent(intent, sealedIntentSha256, reasons);
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) reasons.push('missing_har');
  if (reasons.length) return {status:'rejected', reasons:[...new Set(reasons)], requestProven:false, responseAccepted:false, receiptCertified:false};

  const submitPosts = entries.filter(e => e?.request?.method === 'POST' && /^https:\/\/internshala\.com\/application\/submit\//.test(e.request.url ?? ''));
  if (submitPosts.length !== 1) reasons.push('missing_or_multiple_submit_posts');
  const entry = submitPosts[0];
  if (entry?.request?.url !== identity.submitUrl) reasons.push('submit_endpoint_mismatch');
  if (entries.some(e => e?.request?.method === 'POST' && /\/application\/submit\//.test(e?.request?.url ?? '') && e !== entry)) reasons.push('extra_submit_post');
  if (reasons.length) return {status:'rejected',reasons:[...new Set(reasons)],requestProven:false,responseAccepted:false,receiptCertified:false};

  const postData = entry.request.postData;
  const type = postData?.mimeType || entry.request.headers?.find(h => h.name?.toLowerCase() === 'content-type')?.value;
  const match = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))$/i.exec(type ?? '');
  if (!match) reasons.push('unexpected_content_type');
  const bytes = decodeBase64(postData?.bodyBase64);
  if (!bytes) reasons.push('native_request_bytes_missing');
  if (bytes && postData?.bodySha256 !== sha256(bytes)) reasons.push('native_request_hash_mismatch');
  const parts = bytes && match ? multipartParts(bytes, match[1] || match[2]) : null;
  if (bytes && match && !parts) reasons.push('malformed_multipart_body');
  if (parts) {
    const nativeDuplicate=!!internshalaNativeContract(intent.sourceUrl) && intent.nativeForm?.contract===internshalaNativeContract(intent.sourceUrl)?.id && intent.nativeForm.pdfPartCount===2;
    if([...parts].some(([name,values])=>values.length!==1 && !(nativeDuplicate && name===intent.pdf.fieldName && values.length===2)))reasons.push('duplicate_form_field');
    const job = parts.get(intent.jobIdField)?.[0];
    if (!job || job.filename !== null || job.bytes.toString('utf8') !== intent.jobId) reasons.push('job_id_mismatch');
    for (const [key, field] of Object.entries(intent.fields)) {
      const actual = parts.get(key)?.[0];
      if (!actual || actual.filename !== null || actual.bytes.toString('utf8') !== field.value) reasons.push('form_field_mismatch');
    }
    for(const [key,field] of Object.entries(intent.protocolFields ?? {})) {
      const actual=parts.get(key)?.[0];
      if(!actual || actual.filename!==null || actual.bytes.toString('utf8')!==field.value)reasons.push('protocol_field_mismatch');
    }
    const pdfs=parts.get(intent.pdf.fieldName);
    if(!pdfs || pdfs.length!==(nativeDuplicate?2:1) || pdfs.some(pdf=>pdf.filename !== intent.pdf.filename || pdf.bytes.length !== intent.pdf.size || sha256(pdf.bytes) !== intent.pdf.sha256 || !/\.pdf$/i.test(pdf.filename) || !/^Content-Type:\s*application\/pdf\s*$/im.test(pdf.headers))) reasons.push('pdf_boundary_mismatch');
    const expectedNames=new Set([intent.jobIdField,...Object.keys(intent.fields),...Object.keys(intent.protocolFields ?? {}),intent.pdf.fieldName]);
    if ([...parts.keys()].some(name=>!expectedNames.has(name))) reasons.push('unexpected_form_field');
  }
  const requestProven = reasons.length === 0;
  const status = entry.response?.status;
  const data = responseJson(entry);
  const responseAccepted = Number.isInteger(status) && status >= 200 && status < 300 && data?.success === true;
  if (!Number.isInteger(status) || status === 0) reasons.push('response_lost');
  else if (status < 200 || status >= 300 || data?.success === false) reasons.push('provider_rejected');
  else if (!responseAccepted) reasons.push('accepted_response_not_proven');
  const receipt=responseAccepted && requestProven ? historyReceipt(history,intent,entry) : null;
  if (responseAccepted && !receipt) reasons.push('exact_my_applications_card_missing');
  const certified=requestProven && responseAccepted && !!receipt;
  return {
    status:certified ? 'accepted' : reasons.includes('provider_rejected') ? 'rejected' : reasons.includes('response_lost') ? 'uncertain' : 'held',
    reasons:[...new Set(reasons)], requestProven, responseAccepted,
    receiptCertified:certified, receipt:certified?receipt:null, submitUrl:identity.submitUrl,
    evidenceSha256:sha256(Buffer.from(JSON.stringify({sealedIntentSha256,har,history}))),
  };
}

export function reconcileInternshalaReceipt(input) {
  // Reconciliation is a pure recheck of existing evidence. Never retry a POST.
  return inspectInternshalaReceipt(input);
}
