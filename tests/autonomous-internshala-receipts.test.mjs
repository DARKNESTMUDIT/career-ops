import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {intentDigest, internshipIdentity, inspectInternshalaReceipt, reconcileInternshalaReceipt} from '../autonomous/internshala-receipts.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pdf = Buffer.from('%PDF-1.4\nsynthetic fixture only\n%%EOF\n');
const sourceUrl='https://internshala.com/internship/detail/work-from-home-product-growth-manager-internship-at-example1792739586';
const intent = () => ({
  sourceUrl, state:'active', durableReference:'sealed-ledger-event-1', reservedBeforeFirstPII:true,
  jobId:'synthetic-job-id', jobIdField:'internship_id', company:'Example', role:'Product & Growth Manager Intern',
  approvedSources:['primary-profile','current-cv'],
  sourceProofs:{'primary-profile':{sha256:hash(Buffer.from('synthetic primary source'))},'current-cv':{sha256:hash(Buffer.from('synthetic CV source'))}},
  fields:{answer_1:{value:'synthetic approved answer',source:'primary-profile',sourceSha256:hash(Buffer.from('synthetic primary source'))},email:{value:'fixture@example.invalid',source:'primary-profile',sourceSha256:hash(Buffer.from('synthetic primary source'))}},
  pdf:{fieldName:'resume',filename:'synthetic.pdf',size:pdf.length,sha256:hash(pdf),frozenBeforeIntent:true},
});

function multipart(fields, boundary='synthetic-boundary') {
  const chunks=[];
  for(const [name,value] of Object.entries(fields)) {
    const file=value && typeof value==='object' && value.bytes;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file?`; filename="${value.filename}"`:''}\r\n${file?'Content-Type: application/pdf\r\n':''}\r\n`));
    chunks.push(file?value.bytes:Buffer.from(value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function fixture(changes={}) {
  const i=intent();
  const bytes=multipart({internship_id:i.jobId,answer_1:i.fields.answer_1.value,email:i.fields.email.value,resume:{filename:i.pdf.filename,bytes:pdf}});
  const entry={startedDateTime:'2026-10-25T05:00:00.000Z',request:{method:'POST',url:internshipIdentity(i.sourceUrl).submitUrl,postData:{mimeType:'multipart/form-data; boundary=synthetic-boundary',bodyBase64:bytes.toString('base64'),bodySha256:hash(bytes)}},response:{status:200,content:{text:'{"success":true}'}}};
  const har={log:{entries:[entry]}};
  return {intent:i,sealedIntentSha256:intentDigest(i),har,...changes};
}

test('exact source URL and native submit slug only',()=>{
  assert.equal(internshipIdentity(sourceUrl)?.submitUrl,'https://internshala.com/application/submit/work-from-home-product-growth-manager-internship-at-example1792739586');
  for(const bad of [sourceUrl+'?x=1',sourceUrl.replace('https:','http:'),sourceUrl.replace('internshala.com','internshala.com.evil.test')])assert.equal(internshipIdentity(bad),null);
});

test('complete native request and success response remain unconfirmed without matching My Applications card',()=>{
  const result=inspectInternshalaReceipt(fixture());
  assert.equal(result.status,'held');assert.equal(result.requestProven,true);assert.equal(result.responseAccepted,true);assert.equal(result.receiptCertified,false);
  assert.deepEqual(result.reasons,['exact_my_applications_card_missing']);
  assert.deepEqual(reconcileInternshalaReceipt(fixture()).status,'held');
});

function history(i) {
  const beforePageHtml='<html><body><article>No application for this fixture yet</article></body></html>';
  const cardOuterHTML=`<article class="application-card"><a href="${i.sourceUrl}">${i.role} at ${i.company}</a><p>Applied on 25 Oct' 26</p><a href="https://internshala.com/application/view/123456789?referral=dashboard">${i.role} at ${i.company}</a></article>`;
  const afterPageHtml=`<html><body>${cardOuterHTML}</body></html>`;
  return {pageUrl:'https://internshala.com/student/applications/?referral=header',beforePageHtml,beforePageSha256:hash(Buffer.from(beforePageHtml)),beforeObservedAt:'2026-10-25T04:00:00.000Z',afterPageHtml,afterPageSha256:hash(Buffer.from(afterPageHtml)),cardOuterHTML,cardSha256:hash(Buffer.from(cardOuterHTML)),observedAt:'2026-10-25T06:00:00.000Z',screenshotSha256:hash(Buffer.from('synthetic screenshot'))};
}

test('synthetic accepted proof requires exact same-card source, role, company, dated row, and application-view ID',()=>{
  const f=fixture();f.history=history(f.intent);
  const result=inspectInternshalaReceipt(f);
  assert.equal(result.status,'accepted');assert.equal(result.receiptCertified,true);
  assert.equal(result.receipt.applicationId,'123456789');
});

test('historical, mismatched, and unbound My Applications cards remain held',()=>{
  const old=fixture();old.history=history(old.intent);old.history.beforePageHtml+=old.intent.sourceUrl;old.history.beforePageSha256=hash(Buffer.from(old.history.beforePageHtml));
  assert.equal(inspectInternshalaReceipt(old).status,'held');
  const mismatch=fixture();mismatch.history=history(mismatch.intent);mismatch.history.cardOuterHTML=mismatch.history.cardOuterHTML.replaceAll(mismatch.intent.sourceUrl,'https://internshala.com/internship/detail/other123');mismatch.history.cardSha256=hash(Buffer.from(mismatch.history.cardOuterHTML));
  assert.equal(inspectInternshalaReceipt(mismatch).status,'held');
  const unbound=fixture();unbound.history=history(unbound.intent);unbound.history.cardSha256=hash(Buffer.from('something else'));
  assert.equal(inspectInternshalaReceipt(unbound).status,'held');
});

test('missing native PDF/request bytes cannot be reconstructed from planned fields',()=>{
  const f=fixture();delete f.har.log.entries[0].request.postData.bodyBase64;
  const result=inspectInternshalaReceipt(f);
  assert.equal(result.status,'held');assert.equal(result.requestProven,false);assert.ok(result.reasons.includes('native_request_bytes_missing'));
});

test('modified answer, stale PDF, or body-hash corruption fails request proof',()=>{
  const wrongAnswer=fixture();wrongAnswer.intent.fields.answer_1.value='changed after intent';wrongAnswer.sealedIntentSha256=intentDigest(wrongAnswer.intent);
  assert.ok(inspectInternshalaReceipt(wrongAnswer).reasons.includes('form_field_mismatch'));
  const stalePdf=fixture();stalePdf.intent.pdf.sha256=hash(Buffer.from('different PDF'));stalePdf.sealedIntentSha256=intentDigest(stalePdf.intent);
  assert.ok(inspectInternshalaReceipt(stalePdf).reasons.includes('pdf_boundary_mismatch'));
  const corrupt=fixture();corrupt.har.log.entries[0].request.postData.bodySha256=hash(Buffer.from('different body'));
  assert.ok(inspectInternshalaReceipt(corrupt).reasons.includes('native_request_hash_mismatch'));
});

test('intent seal, approved-source, and pre-PII reservation are required',()=>{
  const unsealed=fixture();unsealed.intent.fields.email.value='modified';
  assert.ok(inspectInternshalaReceipt(unsealed).reasons.includes('intent_seal_mismatch'));
  const unapproved=fixture();unapproved.intent.fields.email.source='invented';unapproved.sealedIntentSha256=intentDigest(unapproved.intent);
  assert.ok(inspectInternshalaReceipt(unapproved).reasons.includes('unapproved_or_missing_field'));
  const late=fixture();late.intent.reservedBeforeFirstPII=false;late.sealedIntentSha256=intentDigest(late.intent);
  assert.ok(inspectInternshalaReceipt(late).reasons.includes('inactive_or_unproven_intent'));
});

test('different role endpoint and duplicate application POSTs are rejected',()=>{
  const mismatch=fixture();mismatch.har.log.entries[0].request.url+='-other';
  assert.equal(inspectInternshalaReceipt(mismatch).status,'rejected');
  const duplicate=fixture();duplicate.har.log.entries.push(structuredClone(duplicate.har.log.entries[0]));
  assert.equal(inspectInternshalaReceipt(duplicate).status,'rejected');
});

test('lost response is uncertain and native negative response is rejected',()=>{
  const lost=fixture();delete lost.har.log.entries[0].response;
  assert.equal(inspectInternshalaReceipt(lost).status,'uncertain');
  const rejected=fixture();rejected.har.log.entries[0].response={status:200,content:{text:'{"success":false}'}};
  assert.equal(inspectInternshalaReceipt(rejected).status,'rejected');
});

test('an elided response or generic thank-you cannot establish acceptance',()=>{
  const absent=fixture();absent.har.log.entries[0].response.content={};
  assert.equal(inspectInternshalaReceipt(absent).responseAccepted,false);
  const toast=fixture();toast.har.log.entries[0].response.content.text='<html>Thank you</html>';
  assert.equal(inspectInternshalaReceipt(toast).responseAccepted,false);
});

test('extra prefilled CV field and absent input are rejected or held',()=>{
  const extra=fixture();
  const body=multipart({internship_id:extra.intent.jobId,answer_1:extra.intent.fields.answer_1.value,email:extra.intent.fields.email.value,old_resume:'stale-profile-cv',resume:{filename:extra.intent.pdf.filename,bytes:pdf}});
  extra.har.log.entries[0].request.postData.bodyBase64=body.toString('base64');extra.har.log.entries[0].request.postData.bodySha256=hash(body);
  assert.ok(inspectInternshalaReceipt(extra).reasons.includes('unexpected_form_field'));
  assert.equal(inspectInternshalaReceipt({}).status,'rejected');
});
