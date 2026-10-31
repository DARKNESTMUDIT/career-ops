import {internshalaNativeContract,nativeQuestionSchema} from './internshala-contracts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {internshalaSessionLaunchOptions,inspectStudentSession} from './internshala-session.mjs';
import {installInternshalaScriptAttestation,inspectInternshalaNativeForm,planInternshalaNativeSubmission,prepareInternshalaNativeSubmission,assertInternshalaScriptAttestation,validateInternshalaNativeArtifacts} from './internshala-transport.mjs';
import {captureInternshalaNativeSubmission} from './internshala-capture.mjs';
import {intentDigest,inspectInternshalaReceipt} from './internshala-receipts.mjs';
import * as nativeReceipts from './internshala-receipts.mjs';
import * as nativeHistory from './internshala-history.mjs';
import {authorizeSubmission,integrityPause} from './rollout.mjs';
import {verifyBundle} from './bundle.mjs';
import {availabilityDisclosure} from './availability.mjs';
import {assess,hash,identityKey,quantifiedEvidenceIssues,validateClaims} from './policy.mjs';
import {loadContext,trackerIdentities} from './runner.mjs';
import {fetchFullPosting} from './discovery.mjs';
import {syncReceipt} from './tracker.mjs';
import {findBlacklistEntry} from '../scan.mjs';

// Exact observed native contracts; live authorization independently gates each role.
// Engineering fixtures never grant application or rollout receipt credit.
// No retries, alternate POSTs, account creation, cookie export or resume reuse.
const sha=value=>createHash('sha256').update(value).digest('hex');
const primary=['cv.md','config/profile.yml','modes/_profile.md'];
const observationSessions=new WeakMap();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function privateBytes(file,root) {
  const resolved=fs.realpathSync(file),base=fs.realpathSync(root),stat=fs.statSync(resolved);
  if(!resolved.startsWith(base+path.sep) || !stat.isFile() || (stat.mode&0o077))throw Error('Private application artifact required');
  return fs.readFileSync(resolved);
}
function persist(file,value) {
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2));
  const fd=fs.openSync(file,'wx',0o600);
  try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally {fs.closeSync(fd);}
  const dir=fs.openSync(path.dirname(file),'r');try {fs.fsyncSync(dir);}finally {fs.closeSync(dir);}
  return {path:file,sha256:sha(bytes)};
}
function exactJob(job) {
  const contract=internshalaNativeContract(job?.url);
  if(!contract || job.payload?.sourceUrl!==job.url || job.payload?.role!==contract.role || contract.company && job.payload?.company!==contract.company)throw Error('Only exact observed native role/company contracts are supported');
  return contract;
}

// Uses only the already dedicated profile and ordinary visible vendor Chrome
// with OS Keychain. Verification never returns credentials or browser cookies.
export async function withInternshalaApplicationSession(root,work) {
  const context=loadContext(root),directory=path.join(root,'data/autonomous/browser-profile');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const browser=await chromium.launchPersistentContext(directory,internshalaSessionLaunchOptions());
  const deny=route=>['GET','HEAD'].includes(route.request().method())?route.continue():route.abort('blockedbyclient');
  try {
    await browser.route('**/*',deny);
    const account=await browser.newPage();
    await account.goto('https://internshala.com/student/resume',{waitUntil:'domcontentloaded',timeout:30000});
    const state=await inspectStudentSession(account,context.profile.candidate.email);
    if(!state.connected || !state.accountMatched)throw Error('Dedicated Internshala student session is not authenticated to the primary account');
    await account.close();
    // Context denies mutations until native capture installs its page route.
    return await work(await browser.newPage());
  }finally {await browser.close();}
}

// Observation opens exactly one caller-reviewed native easy-apply control.
// The deny route remains installed on failure. No candidate controls are filled.
export async function observeInternshalaApplication(page,{ledger,id,directory}) {
  const job=ledger.job(id);exactJob(job);
  if(!ledger.ownsLock() || ledger.get('paused') || ledger.get('integrityFailure'))throw Error('Active unpaused runner lock required');
  const root=fs.realpathSync(ledger.dir),parent=fs.realpathSync(path.dirname(directory));
  if(parent!==root && !parent.startsWith(root+path.sep))throw Error('Private observation directory required');
  const deny=route=>['GET','HEAD'].includes(route.request().method())?route.continue():route.abort('blockedbyclient');
  await page.route('**/*',deny);
  const attestation=installInternshalaScriptAttestation(page,{sourceUrl:job.url,directory,root:ledger.dir});
  await page.goto(job.url,{waitUntil:'domcontentloaded',timeout:30000});
  const script=await attestation.wait();
  const button=page.locator('#top_easy_apply_button');
  if(await button.count()!==1 || !await button.isVisible() || !await button.isEnabled())throw Error('Observed native easy-apply control unavailable');
  await button.click({timeout:15000});
  const observation=await inspectInternshalaNativeForm(page,{sourceUrl:job.url});
  const formArtifact=persist(path.join(directory,'observed-form.html'),observation.outerHTML);
  const contract=exactJob(job);
  const nativeForm={contract:contract.id,pdfPartCount:2,formArtifact,...script,...(contract.questions.length?{questionSchema:nativeQuestionSchema(contract)}:{})};
  observationSessions.set(page,{id,sourceUrl:job.url,nativeForm,observation,deny,attestation});
  return {observation,nativeForm};
}

export function validateInternshalaApplicationAnswers({context,job,answers}) {
  if(answers?.reviewed!==true || !answers.fields || !Object.keys(answers.fields).length)throw Error('Reviewed mandatory answers required');
  const contract=internshalaNativeContract(job.sourceUrl);
  const proofs=Object.fromEntries(primary.map(source=>{
    if(typeof context.sources?.[source]!=='string')throw Error('Current primary sources required');
    return [source,{sha256:sha(context.sources[source])}];
  }));
  for(const [name,field] of Object.entries(answers.fields)) {
    if(!primary.includes(field?.source) || field.sourceSha256!==proofs[field.source]?.sha256 || typeof field.quote!=='string' || !field.quote.trim() || !context.sources[field.source].includes(field.quote))throw Error('Mandatory answer lacks exact current primary provenance');
    if(name!=='confirm_availability' && !contract?.questions.some(question=>question.name===name && ['primary-boolean','primary-rating'].includes(question.answerKind)) && field.value!==field.quote && !(name==='confirm_availability_textarea' && field.value===availabilityDisclosure(context,job)))throw Error('Mandatory answer text must be primary-backed and reviewed');
  }
  if(answers.fields.confirm_availability?.value==='yes') {
    const remote=context.profile?.availability?.remote;
    if(job.track!=='remote' || remote?.earliest_start!=='immediate' || !/remote/i.test(remote.workplace || '') || answers.fields.confirm_availability.source!=='config/profile.yml' || !/immediate/i.test(answers.fields.confirm_availability.quote))throw Error('Immediate availability requires explicit primary remote availability');
  }
  for(const question of contract?.questions ?? []) {
    const field=answers.fields[question.name];
    if(!field)throw Error('Reviewed required native question answer missing');
    if(question.answerKind==='primary-boolean') {
      const value=context.profile.application_answers?.[question.primaryKey];
      if(typeof value!=='boolean' || field.source!=='config/profile.yml' || field.mapping!==question.mapping || field.quote!==`${question.primaryKey}: ${value}` || field.value!==(value===true?'Yes':'No'))throw Error('Exact current primary boolean mapping required');
    }
    if(question.answerKind==='primary-rating') {
      const values=context.profile.application_answers,rating=values?.project_management_self_rating;
      if(!Number.isInteger(rating) || rating<1 || rating>5 || values.project_management_rating_scale!==5 || field.source!=='config/profile.yml' || field.mapping!==question.mapping || field.value!==String(rating) || !new RegExp(`^project_management_self_rating: ${rating}\\n[ \\t]+project_management_rating_scale: 5$`).test(field.quote))throw Error('Exact current primary integer rating and scale mapping required');
    }
    if(question.answerKind==='tool-familiarity' && (field.source!=='cv.md' || !/^(?:Claude(?: Code)?|ChatGPT)(?:, (?:Claude(?: Code)?|ChatGPT))*$/.test(field.value)))throw Error('Only primary-backed tool familiarity is approved for this question');
    if(question.answerKind==='general-portfolio-url' && (field.source!=='config/profile.yml' || field.value!==context.profile.candidate?.portfolio_url || !/^https:\/\//.test(field.value)))throw Error('Only the approved general portfolio URL is available; no research sample claim is inferred');
  }
  const summer=context.profile?.availability?.summer;
  if(job.track==='summer' && (summer?.earliest_start!=='2027-06-01' || summer.latest_end!=='2027-07-31'))throw Error('Summer availability must remain June 1 to July 31, 2027');
  return {approvedSources:primary,sourceProofs:proofs};
}

// A custom PDF does not replace Internshala's separately shared built-in CV.
// Require a source-backed review of that actual current protected resume too.
export function validateInternshalaPlatformResumeReview({review,observedSha256,context}) {
  if(review?.version!==1 || review.reviewed!==true || review.conformsToPrimary!==true || !Array.isArray(review.discrepancies) || review.discrepancies.length || review.observedSha256!==observedSha256 || !/^[a-f0-9]{64}$/.test(observedSha256 || ''))throw Error('Current built-in Internshala resume requires primary-backed review');
  for(const source of primary)if(review.sourceProofs?.[source]?.sha256!==sha(context.sources[source]))throw Error('Built-in resume review is stale against primary sources');
  return true;
}
async function verifyPlatformResumeReview(page,{context,ledger,artifact}) {
  if(!artifact?.path || !/^[a-f0-9]{64}$/.test(artifact.sha256 || ''))throw Error('Private reviewed built-in resume artifact required');
  const bytes=privateBytes(artifact.path,ledger.dir);
  if(sha(bytes)!==artifact.sha256)throw Error('Built-in resume review artifact changed');
  const review=JSON.parse(bytes.toString('utf8')),account=await page.context().newPage();
  try {
    await account.route('**/*',route=>['GET','HEAD'].includes(route.request().method())?route.continue():route.abort('blockedbyclient'));
    await account.goto('https://internshala.com/student/resume',{waitUntil:'domcontentloaded',timeout:30000});
    const state=await inspectStudentSession(account,context.profile.candidate.email);
    if(!state.connected || !state.accountMatched)throw Error('Primary student account must remain authenticated');
    const text=await account.locator('#resume-container').innerText();
    validateInternshalaPlatformResumeReview({review,observedSha256:sha(text),context});
    return artifact;
  }finally {await account.close();}
}

// Read-only preparation, suitable for sealBundle. Selecting the frozen PDF and
// filling controls happen exclusively after reservation in submit below.
export async function prepareInternshalaApplication(page,{ledger,id,context,answers,bundle,platformResumeReview}) {
  const job=ledger.job(id);exactJob(job);
  const observed=observationSessions.get(page);
  if(!observed || observed.id!==id || observed.sourceUrl!==job.url)throw Error('Page-bound original native observation required');
  await verifyPlatformResumeReview(page,{context,ledger,artifact:platformResumeReview});
  const provenance=validateInternshalaApplicationAnswers({context,job:job.payload,answers});
  const pdfPath=path.join(bundle,'resume.pdf'),bytes=privateBytes(pdfPath,ledger.dir);
  if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw Error('Frozen private PDF required');
  const html=privateBytes(path.join(bundle,'resume.html'),ledger.dir).toString('utf8');
  const disclosure=availabilityDisclosure(context,job.payload);
  if(disclosure && !disclosure.split('\n\n').every(text=>html.includes(escape(text))))throw Error('Application PDF source must include all current availability and eligibility disclosures');
  const claims=JSON.parse(privateBytes(path.join(bundle,'claims.json'),ledger.dir).toString('utf8'));
  validateClaims(claims,Object.fromEntries(primary.map(source=>[source,context.sources[source]])));
  const pdf={fieldName:'custom_resume',filename:'resume.pdf',size:bytes.length,sha256:sha(bytes),frozenBeforeIntent:true};
  const plan=planInternshalaNativeSubmission({...observed,sourceUrl:job.url,answers,...provenance,pdf});
  plan.platformResumeReview=platformResumeReview;
  validateInternshalaNativeArtifacts({...plan,nativeForm:observed.nativeForm},ledger.dir);
  assertInternshalaScriptAttestation(page,plan,ledger.dir);
  const current=await inspectInternshalaNativeForm(page,{sourceUrl:job.url});
  if(sha(current.outerHTML)!==plan.nativeForm.formArtifact.sha256)throw Error('Observed form changed before preparation');
  const resumeHash=hash(bytes.toString('base64'));
  return {provider:'internshala',complete:true,issues:[],plan,resumeHash,answers:[...Object.entries(plan.fields).map(([name,field])=>({ref:name,label:name,type:'text',...field})),{ref:'custom_resume',label:'Current CV',type:'file',value:'resume.pdf',fileHash:resumeHash}]};
}

// historySnapshot is a read-only capture of actual provider history. It must
// return the exact history evidence understood by inspectInternshalaReceipt;
// neither this callback nor a fixture can grant acceptance or adapter credit.
export async function submitInternshalaPrepared(page,{root,ledger,id,context,prepared,bundle,historySnapshot}) {
  authorizeSubmission(ledger,id,context.fingerprints,'internshala');
  const job=ledger.job(id);exactJob(job);
  if(typeof historySnapshot!=='function')throw Error('Actual provider history snapshot required');
  if(path.resolve(bundle)!==path.resolve(job.payload.bundle) || !same(JSON.parse(privateBytes(path.join(bundle,'answers.json'),ledger.dir).toString('utf8')),prepared))throw Error('Prepared answers differ from sealed bundle');
  if(!prepared.complete || prepared.provider!=='internshala')throw Error('Complete native preparation required');
  const observed=observationSessions.get(page);
  if(!observed || observed.id!==id)throw Error('Original page observation required');
  const before=await historySnapshot({phase:'before',page,sourceUrl:job.url});
  // A provider-only earlier application must be caught before any PII. No
  // caller-defined absence flag can substitute for the provider schema check.
  if(typeof nativeReceipts.assertInternshalaHistoryBefore!=='function')throw Error('Observed provider history baseline validator is not integrated');
  nativeReceipts.assertInternshalaHistoryBefore(before,{sourceUrl:job.url,company:job.payload.company,role:job.payload.role});
  if(typeof nativeHistory.internshalaHistoryDigest!=='function')throw Error('Observed provider history digest is not integrated');
  const historyBeforeSha256=nativeHistory.internshalaHistoryDigest(before);
  const beforeArtifact=persist(path.join(bundle,`internshala-history-before-${randomUUID()}.json`),before);
  // Fresh reads after provider history and before durable intent. No evaluator.
  const current=loadContext(root),capture=await fetchFullPosting(job.url),jd=capture?.text ?? capture?.description;
  const fingerprints={...current.fingerprints,posting:hash(jd || '')};
  if(!verifyBundle(bundle,fingerprints) || assess({...job.payload,jd,active:true},current.policy).state!=='eligible' || quantifiedEvidenceIssues({...job.payload,jd},current.policy).length)throw Error('Current source, bundle or eligibility changed');
  if(findBlacklistEntry(current.blacklist,job.payload.company,job.url))throw Error('Company is on the current do-not-apply list');
  if(trackerIdentities(root).has(identityKey(job.payload.company,job.payload.role)))throw Error('Role already exists in canonical tracker');
  validateInternshalaApplicationAnswers({context:current,job:job.payload,answers:{reviewed:true,fields:prepared.plan.fields}});
  await verifyPlatformResumeReview(page,{context:current,ledger,artifact:prepared.plan.platformResumeReview});
  const fresh=await inspectInternshalaNativeForm(page,{sourceUrl:job.url});
  if(sha(fresh.outerHTML)!==prepared.plan.nativeForm.formArtifact.sha256)throw Error('Native form changed before intent');
  assertInternshalaScriptAttestation(page,prepared.plan,ledger.dir);
  const state=authorizeSubmission(ledger,id,current.fingerprints,'internshala');
  let attempt,native,recorded;
  try {
    attempt=ledger.reserve(id,{limit:state.limit,fingerprints:job.payload.fingerprints});
    const intent={...prepared.plan,state:'active',durableReference:attempt,reservedBeforeFirstPII:true,answersReviewed:true,company:job.payload.company,role:job.payload.role,historyBeforeSha256,historyBeforeArtifact:beforeArtifact};
    const intentFile=path.join(bundle,`internshala-intent-${attempt}.json`),sealedIntentSha256=intentDigest(intent);
    persist(intentFile,intent);
    const options={ledger,id,intentFile,sealedIntentSha256,pdfPath:path.join(bundle,'resume.pdf'),proofDir:path.join(bundle,`internshala-proof-${randomUUID()}`),captureFactory:captureInternshalaNativeSubmission};
    ledger.update(id,'submitting',{internshalaIntentSha256:sealedIntentSha256,internshalaIntentFile:intentFile,internshalaProofDir:options.proofDir,internshalaHistoryBefore:beforeArtifact,internshalaHistoryBeforeSha256:historyBeforeSha256});
    verifyInternshalaHistoryBinding({ledger,id,intent});
    native=await prepareInternshalaNativeSubmission(page,options);
    verifyInternshalaHistoryBinding({ledger,id,intent});
    await native.submit();
    recorded=await native.capture.stop();native=null;
    if(recorded.failures.length)throw Error('Native capture integrity failure');
    const rawInspection=inspectInternshalaReceipt({intent,sealedIntentSha256,har:recorded.har});
    if(!rawInspection.requestProven || !rawInspection.responseAccepted)throw Error('Original native request or accepted response is not proven: '+rawInspection.reasons.join(', '));
    const history=await historySnapshot({phase:'after',page,sourceUrl:job.url,before});
    persist(path.join(options.proofDir,'history.json'),history);
    verifyInternshalaHistoryBinding({ledger,id,intent,history});
    const inspected=inspectInternshalaReceipt({intent,sealedIntentSha256,har:recorded.har,history});
    persist(path.join(options.proofDir,'inspection.json'),inspected);
    if(!inspected.receiptCertified)throw Error('Exact provider receipt not proven: '+inspected.reasons.join(', '));
    const receipt={kind:'form-confirmation',provider:'internshala',reference:`internshala:${inspected.receipt.applicationId}`,sourceUrl:job.url,evidencePath:path.join(options.proofDir,'inspection.json'),evidenceSha256:inspected.evidenceSha256,at:new Date().toISOString()};
    persist(path.join(options.proofDir,'receipt.json'),receipt);
    ledger.receipt(id,receipt);
    try {await syncReceipt(root,ledger,id);}catch(error){ledger.update(id,'confirmed',{trackerSync:{verified:false,error:error.message}});throw error;}
    return {confirmed:true,receipt};
  }catch(error) {
    if(native)try {recorded=await native.capture.stop();}catch {}
    if(attempt) {
      if(!['confirmed','applied'].includes(ledger.job(id)?.state)) {
        ledger.update(id,'uncertain',{reasons:[error.message],noRetry:true});
        try {
          const original=originalEvidence({ledger,id}),inspection=inspectOriginal(original);
          if(inspection.requestProven && definitiveNativeRejection(original) && !inspection.responseAccepted)await reconcileInternshalaApplication({root,ledger,id});
        }catch {}
      }
      integrityPause(ledger,`Internshala submission requires reconciliation: ${error.message}`);
    }
    throw error;
  }
}


// Independently re-read the immutable baseline. Its artifact hash protects
// bytes on disk; its canonical provider digest binds source and all raw reads
// into the sealed native intent and ledger, including after crash recovery.
export function verifyInternshalaHistoryBinding({ledger,id,intent,history}) {
  if(typeof nativeHistory.internshalaHistoryDigest!=='function' || typeof nativeReceipts.assertInternshalaHistoryBefore!=='function')throw Error('Provider history proof validator is not integrated');
  const job=ledger.job(id),artifact=intent?.historyBeforeArtifact;
  if(!artifact?.path || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '') || !same(artifact,job?.payload?.internshalaHistoryBefore) || intent.historyBeforeSha256!==job.payload.internshalaHistoryBeforeSha256)throw Error('Durable history baseline binding mismatch');
  const bytes=privateBytes(artifact.path,ledger.dir);
  if(sha(bytes)!==artifact.sha256)throw Error('Immutable provider history baseline changed');
  const before=JSON.parse(bytes.toString('utf8'));
  if(nativeHistory.internshalaHistoryDigest(before)!==intent.historyBeforeSha256)throw Error('Provider history baseline differs from sealed intent');
  nativeReceipts.assertInternshalaHistoryBefore(before,{sourceUrl:intent.sourceUrl,company:intent.company,role:intent.role});
  if(history && nativeHistory.internshalaHistoryDigest(history.before)!==intent.historyBeforeSha256)throw Error('Receipt history baseline differs from durable intent');
  for(const snapshot of [before,...(history?[history.after]:[])]) {
    nativeHistory.internshalaHistoryDigest(snapshot);
    for(const proof of [...snapshot.responses.map(response=>response.artifact),snapshot.ui.pageArtifact,snapshot.ui.screenshotArtifact]) {
      if(sha(privateBytes(proof.path,ledger.dir))!==proof.sha256)throw Error('Provider history baseline or receipt raw artifact changed');
    }
  }
  return {historyBeforeSha256:intent.historyBeforeSha256,before};
}

// Browser protocol values may change between an honest dry run and a fresh
// native observation. Candidate content, PDF bytes and provenance may not.
export function compareInternshalaCandidatePreparation(previous,current) {
  for(const prepared of [previous,current])if(prepared?.provider!=='internshala' || prepared.complete!==true || prepared.issues?.length)throw Error('Complete native preparations required for protocol resealing');
  for(const name of ['sourceUrl','jobId','jobIdField','fields','approvedSources','sourceProofs','pdf'])if(!same(previous.plan?.[name],current.plan?.[name]))throw Error(`Candidate preparation changed: ${name}`);
  if(previous.resumeHash!==current.resumeHash || previous.plan?.platformResumeReview?.sha256!==current.plan?.platformResumeReview?.sha256 || !same(previous.answers,current.answers))throw Error('Reviewed candidate answers, platform resume review or PDF changed');
  return true;
}

function nativeEvent(ledger,id,kind,attempt) {
  const found=ledger.db.prepare('SELECT detail FROM events WHERE job_id=? AND kind=?').all(id,kind).map(row=>JSON.parse(row.detail)).filter(detail=>detail.attempt===attempt);
  if(found.length!==1)throw Error('Missing or repeated durable native evidence event');
  return found[0];
}
function originalEvidence({ledger,id,beforeSendOnly=false}) {
  if(!ledger.ownsLock())throw Error('Native reconciliation requires active runner lock');
  const job=ledger.job(id);exactJob(job);
  const attempt=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
  if(!attempt || !(beforeSendOnly?['intent','aborted-before-send']:['intent','confirmed','rejected']).includes(attempt.outcome))throw Error('Durable native attempt required');
  if(!same(nativeEvent(ledger,id,'submission-intent',attempt.id).fingerprints,job.payload.fingerprints))throw Error('Original native reservation fingerprints changed');
  const bytes=file=>privateBytes(file,ledger.dir),read=file=>JSON.parse(bytes(file).toString('utf8'));
  const intent=read(job.payload.internshalaIntentFile),proofDir=job.payload.internshalaProofDir;
  if(intent.durableReference!==attempt.id || intent.sourceUrl!==job.url || intent.company!==job.payload.company || intent.role!==job.payload.role || intentDigest(intent)!==job.payload.internshalaIntentSha256)throw Error('Stored native intent identity mismatch');
  if(intent.nativeForm?.contract!==internshalaNativeContract(intent.sourceUrl)?.id)throw Error('Complete original native form and script proof required');
  validateInternshalaNativeArtifacts(intent,ledger.dir);
  if(!same(intent.approvedSources,primary) || !same(Object.keys(intent.sourceProofs || {}).sort(),[...primary].sort()))throw Error('Complete original primary proof set required');
  for(const source of primary) {
    const key={'cv.md':'cv','config/profile.yml':'profile','modes/_profile.md':'targeting'}[source],proof=intent.sourceProofs[source];
    if(!/^[a-f0-9]{64}$/.test(proof?.sha256 || '') || proof.sha256!==job.payload.fingerprints?.[key])throw Error('Original native primary proof differs from reservation fingerprints');
  }
  const reviewed=intent.platformResumeReview;
  if(!reviewed?.path || !/^[a-f0-9]{64}$/.test(reviewed.sha256 || '') || sha(bytes(reviewed.path))!==reviewed.sha256)throw Error('Original reviewed platform resume proof required or changed');
  const review=read(reviewed.path);
  if(review.version!==1 || review.reviewed!==true || review.conformsToPrimary!==true || !Array.isArray(review.discrepancies) || review.discrepancies.length || !/^[a-f0-9]{64}$/.test(review.observedSha256 || '') || primary.some(source=>review.sourceProofs?.[source]?.sha256!==intent.sourceProofs[source].sha256))throw Error('Original platform review is not conforming to historical primary proofs');
  if(typeof job.payload.bundle!=='string' || !verifyBundle(job.payload.bundle,job.payload.fingerprints))throw Error('Complete original sealed application bundle required');
  for(const name of ['manifest.json','jd.txt','resume.html','resume.pdf','claims.json','decision.json','answers.json'])bytes(path.join(job.payload.bundle,name));
  const pdf=bytes(path.join(job.payload.bundle,'resume.pdf'));
  if(!pdf.subarray(0,5).equals(Buffer.from('%PDF-')) || sha(pdf)!==intent.pdf?.sha256 || pdf.length!==intent.pdf?.size)throw Error('Original frozen PDF changed');
  const prepared=read(path.join(job.payload.bundle,'answers.json'));
  if(prepared.provider!=='internshala' || prepared.complete!==true || !Array.isArray(prepared.issues) || prepared.issues.length || prepared.resumeHash!==hash(pdf.toString('base64')))throw Error('Original complete native preparation required');
  for(const key of ['sourceUrl','jobId','jobIdField','fields','protocolFields','pdf','nativeForm','approvedSources','sourceProofs','platformResumeReview'])if(!same(prepared.plan?.[key],intent[key]))throw Error('Original sealed native preparation differs from intent');
  const baseline=verifyInternshalaHistoryBinding({ledger,id,intent});
  const captureIntentFile=path.join(proofDir,'capture-intent.json'),captureIntent=read(captureIntentFile);
  if(captureIntent.attempt!==attempt.id || captureIntent.ledgerJobId!==id || captureIntent.sealedIntentSha256!==job.payload.internshalaIntentSha256 || !same(captureIntent.intent,intent) || nativeEvent(ledger,id,'internshala-capture-started',attempt.id).seal!==sha(bytes(captureIntentFile)))throw Error('Private capture intent does not match durable reservation');
  if(beforeSendOnly) {
    const captureFile=path.join(proofDir,'capture.json'),captured=read(captureFile);
    const wireEvents=ledger.db.prepare("SELECT kind FROM events WHERE job_id=? AND kind IN ('internshala-native-request-observed','internshala-native-response-observed')").all(id);
    if(wireEvents.length || ['request.json','response.json','response-metadata.json'].some(name=>fs.existsSync(path.join(proofDir,name))) || captured.attempt!==attempt.id || captured.continued!==false || !Array.isArray(captured.failures) || captured.failures.length || !same(captured.har,{log:{entries:[]}}))throw Error('A completed zero-wire capture is required; missing or uncertain evidence cannot prove no send');
    return {job,attempt,intent,proofDir,before:baseline.before,read,bytes,captureFile,captureSha256:sha(bytes(captureFile))};
  }
  const requestFile=path.join(proofDir,'request.json'),request=read(requestFile);
  if(nativeEvent(ledger,id,'internshala-native-request-observed',attempt.id).requestHash!==sha(bytes(requestFile)))throw Error('Original native request differs from durable event');
  const responseFile=path.join(proofDir,'response.json');
  let response={};
  if(fs.existsSync(responseFile)) {
    response=read(responseFile);
    if(nativeEvent(ledger,id,'internshala-native-response-observed',attempt.id).responseHash!==sha(bytes(responseFile)))throw Error('Original native response differs from durable event');
  }
  const har={log:{entries:[{...request,response}]}},captureFile=path.join(proofDir,'capture.json');
  if(fs.existsSync(captureFile)) {
    const captured=read(captureFile);
    if(captured.attempt!==attempt.id || !Array.isArray(captured.failures) || captured.failures.length || captured.continued!==true || !same(captured.har,har))throw Error('Stored native capture is incomplete or compromised');
  }
  return {job,attempt,intent,har,proofDir,before:baseline.before,read,bytes};
}
function definitiveNativeRejection(evidence) {
  try {
    const response=evidence.har.log.entries[0].response,content=response.content;
    if(!Number.isInteger(response.status) || response.status<200 || response.status>=600 || content.encoding!=='base64')return false;
    return JSON.parse(Buffer.from(content.text,'base64').toString('utf8'))?.success===false;
  }catch {return false;}
}
function inspectOriginal(evidence,history) {
  return inspectInternshalaReceipt({intent:evidence.intent,sealedIntentSha256:evidence.job.payload.internshalaIntentSha256,har:evidence.har,history});
}

// Pure durable-proof verification for canonical recovery. No provider access,
// send, history fabrication, tracker mutation or rollout credit occurs here.
export function verifyInternshalaApplicationReceipt({ledger,id}) {
  const evidence=originalEvidence({ledger,id}),{job,attempt,intent,read}=evidence;
  if(attempt.outcome==='rejected')throw Error('Rejected attempt cannot receive application credit');
  const proofDir=job.payload.internshalaReceiptProofDir || evidence.proofDir;
  const history=read(path.join(proofDir,'history.json'));
  verifyInternshalaHistoryBinding({ledger,id,intent,history});
  const inspected=inspectOriginal(evidence,history);
  if(!inspected.receiptCertified || !same(read(path.join(proofDir,'inspection.json')),inspected))throw Error('Durable exact provider receipt cannot be re-proven');
  const receipt=read(path.join(proofDir,'receipt.json'));
  if(receipt.kind!=='form-confirmation' || receipt.provider!=='internshala' || receipt.reference!==`internshala:${inspected.receipt.applicationId}` || receipt.sourceUrl!==job.url || receipt.evidencePath!==path.join(proofDir,'inspection.json') || receipt.evidenceSha256!==inspected.evidenceSha256 || !Number.isFinite(Date.parse(receipt.at)))throw Error('Canonical native receipt differs from preserved proof');
  if(attempt.outcome==='confirmed' && !same(JSON.parse(attempt.receipt),receipt))throw Error('Ledger receipt differs from preserved proof');
  return {receipt,inspection:inspected};
}
export function internshalaRejectionSnapshot(ledger,id) {
  const job=ledger.job(id),attempt=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
  const intent=JSON.parse(privateBytes(job.payload.internshalaIntentFile,ledger.dir).toString('utf8'));
  const baseline=JSON.parse(privateBytes(intent.historyBeforeArtifact.path,ledger.dir).toString('utf8'));
  const paths=[job.payload.internshalaIntentFile,intent.historyBeforeArtifact.path,...baseline.responses.map(proof=>proof.artifact.path),baseline.ui.pageArtifact.path,baseline.ui.screenshotArtifact.path];
  for(const descriptor of [intent.nativeForm?.scriptArtifact,intent.nativeForm?.scriptAttestation,intent.nativeForm?.formArtifact,intent.platformResumeReview])if(descriptor?.path)paths.push(descriptor.path);
  for(const name of ['capture-intent.json','request.json','response.json','response-metadata.json','capture.json'])paths.push(path.join(job.payload.internshalaProofDir,name));
  if(job.payload.internshalaRejectionProofDir)for(const name of ['original-native-capture.json','inspection.json','rejected-receipt.json'])paths.push(path.join(job.payload.internshalaRejectionProofDir,name));
  if(job.payload.bundle)for(const name of ['manifest.json','jd.txt','resume.html','resume.pdf','claims.json','decision.json','answers.json'])paths.push(path.join(job.payload.bundle,name));
  const events=ledger.db.prepare("SELECT kind,detail FROM events WHERE job_id=? AND kind IN ('submission-intent','internshala-capture-started','internshala-native-request-observed','internshala-native-response-observed','form-rejected') ORDER BY id").all(id);
  const files=[...new Set(paths)].sort().map(file=>[file,fs.existsSync(file)?sha(privateBytes(file,ledger.dir)):null]);
  return sha(JSON.stringify({job,attempt,events,files}));
}
export function verifyInternshalaRejectedReceipt({ledger,id}) {
  const snapshot=internshalaRejectionSnapshot(ledger,id),evidence=originalEvidence({ledger,id});
  const {job,attempt,read}=evidence,proofDir=job.payload.internshalaRejectionProofDir;
  if(attempt.outcome!=='rejected' || !['exception','rejected'].includes(job.state) || job.payload.trackerSync?.verified===true || job.payload.noRetry!==true)throw Error('Rejected native attempt is not durably reconciled');
  const inspected=inspectOriginal(evidence);
  if(!inspected.requestProven || inspected.responseAccepted || !inspected.reasons.includes('provider_rejected') || !definitiveNativeRejection(evidence) || !same(read(path.join(proofDir,'inspection.json')),inspected))throw Error('Definitive original native rejection is not proven');
  const receipt=read(path.join(proofDir,'rejected-receipt.json'));
  if(receipt.kind!=='form-rejected' || receipt.provider!=='internshala' || receipt.reference!==`internshala-rejected:${attempt.id}:${inspected.evidenceSha256}` || receipt.sourceUrl!==job.url || receipt.evidencePath!==path.join(proofDir,'inspection.json') || receipt.evidenceSha256!==inspected.evidenceSha256 || receipt.noRetry!==true || !Number.isFinite(Date.parse(receipt.at)) || !same(JSON.parse(attempt.receipt),receipt) || snapshot!==internshalaRejectionSnapshot(ledger,id))throw Error('Rejected native receipt integrity mismatch');
  return {receipt,snapshot};
}

// A reserved local interaction can fail before the first admitted application
// request. This is terminal and grants no application credit or retry rights.
// Missing captures, any admitted request/event, response or capture failure
// remain uncertain. The entire original sealed preparation is still required.
export function internshalaUnsentSnapshot(ledger,id) {
  const job=ledger.job(id),file=job?.payload?.internshalaUnsentReceiptFile;
  return sha(JSON.stringify({base:internshalaRejectionSnapshot(ledger,id),receipt:file?sha(privateBytes(file,ledger.dir)):null,events:ledger.db.prepare("SELECT detail FROM events WHERE job_id=? AND kind='form-not-sent' ORDER BY id").all(id)}));
}
export function verifyInternshalaUnsentReceipt({ledger,id}) {
  const snapshot=internshalaUnsentSnapshot(ledger,id),e=originalEvidence({ledger,id,beforeSendOnly:true});
  const {job,attempt}=e;
  if(attempt.outcome!=='aborted-before-send' || job.state!=='exception' || job.payload.noRetry!==true || job.payload.trackerSync?.verified===true)throw Error('Terminal unsent disposition required');
  const file=job.payload.internshalaUnsentReceiptFile,receipt=e.read(file),event=nativeEvent(ledger,id,'form-not-sent',attempt.id);
  if(receipt.kind!=='form-not-sent' || receipt.provider!=='internshala' || receipt.reference!==`internshala-unsent:${attempt.id}` || receipt.sourceUrl!==job.url || receipt.evidencePath!==e.captureFile || receipt.evidenceSha256!==e.captureSha256 || receipt.noRetry!==true || !Number.isFinite(Date.parse(receipt.at)) || event.receiptSha256!==sha(e.bytes(file)) || !same(JSON.parse(attempt.receipt),receipt) || snapshot!==internshalaUnsentSnapshot(ledger,id))throw Error('Unsent receipt or zero-wire capture changed');
  return {receipt,snapshot};
}
export function reconcileUnsentInternshalaAttempt({ledger,id}) {
  const e=originalEvidence({ledger,id,beforeSendOnly:true}),{job,attempt}=e;
  if(attempt.outcome==='aborted-before-send')return {confirmed:false,notSent:true,noRetry:true,...verifyInternshalaUnsentReceipt({ledger,id})};
  if(!['submitting','uncertain'].includes(job.state))throw Error('Reserved unresolved local interaction required');
  const file=path.join(e.proofDir,`not-sent-receipt-${randomUUID()}.json`),receipt={kind:'form-not-sent',provider:'internshala',reference:`internshala-unsent:${attempt.id}`,sourceUrl:job.url,evidencePath:e.captureFile,evidenceSha256:e.captureSha256,noRetry:true,at:new Date().toISOString()},artifact=persist(file,receipt);
  ledger.transaction(()=>{
    const current=ledger.job(id),original=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
    if(!ledger.ownsLock() || original.outcome!=='intent' || !['submitting','uncertain'].includes(current.state) || current.payload.internshalaIntentSha256!==job.payload.internshalaIntentSha256)throw Error('Original local interaction changed');
    originalEvidence({ledger,id,beforeSendOnly:true});
    ledger.db.prepare("UPDATE attempts SET outcome='aborted-before-send',receipt=? WHERE job_id=? AND outcome='intent'").run(JSON.stringify(receipt),id);
    ledger.db.prepare("UPDATE jobs SET state='exception',payload=?,updated=? WHERE id=?").run(JSON.stringify({...current.payload,internshalaUnsentReceiptFile:file,noRetry:true,dryRunComplete:false,reasons:['Completed original capture proves no application request was admitted. Local interaction failed; no credit and never retry this attempt.']}),new Date().toISOString(),id);
    ledger.event(id,'form-not-sent',{attempt:attempt.id,receiptSha256:artifact.sha256,captureSha256:e.captureSha256});
  });
  return {confirmed:false,notSent:true,noRetry:true,...verifyInternshalaUnsentReceipt({ledger,id})};
}

// Pure dispatch preflight. Bad or missing original proof cannot trigger a
// browser launch merely by marking a job uncertain or naming an intent file.
export function inspectInternshalaReconciliationState({ledger,id}) {
  const job=ledger.job(id);
  if(typeof job?.payload?.internshalaProofDir==='string' && !fs.existsSync(path.join(job.payload.internshalaProofDir,'request.json'))) {originalEvidence({ledger,id,beforeSendOnly:true});return {needsHistory:false,notSent:true};}
  const evidence=originalEvidence({ledger,id}),inspected=inspectOriginal(evidence);
  if(!inspected.requestProven)throw Error('Original native request cannot be proven; no retry permitted');
  if(!inspected.responseAccepted)return {needsHistory:false,responseAccepted:false,definitivelyRejected:definitiveNativeRejection(evidence)};
  const directory=evidence.job.payload.internshalaReceiptProofDir || evidence.proofDir;
  const file=path.join(directory,'history.json');
  if(fs.existsSync(file)) {
    const history=evidence.read(file);
    verifyInternshalaHistoryBinding({ledger,id,intent:evidence.intent,history});
    if(inspectOriginal(evidence,history).receiptCertified)return {needsHistory:false,responseAccepted:true};
  }
  return {needsHistory:true,responseAccepted:true};
}

// Reconciliation reuses the original one-shot POST, never a new native submit.
// Only an already proven successful response permits a fresh read-only history
// capture. A missing/unknown response body stays uncertain even if a row exists.
export async function reconcileInternshalaApplication({root,ledger,id,page,historySnapshot}) {
  const existing=ledger.job(id);
  if(typeof existing?.payload?.internshalaProofDir==='string' && !fs.existsSync(path.join(existing.payload.internshalaProofDir,'request.json')))return reconcileUnsentInternshalaAttempt({ledger,id});
  const evidence=originalEvidence({ledger,id}),{job,attempt,intent,before}=evidence;
  if(attempt.outcome==='rejected')return {confirmed:false,rejected:true,noRetry:true,...verifyInternshalaRejectedReceipt({ledger,id})};
  if(attempt.outcome==='confirmed') {
    const {receipt}=verifyInternshalaApplicationReceipt({ledger,id});
    await syncReceipt(root,ledger,id);return {confirmed:true,receipt};
  }
  if(!['submitting','uncertain'].includes(job.state))throw Error('Unresolved original native intent required');
  const initial=inspectOriginal(evidence);
  if(!initial.requestProven)throw Error('Original native request cannot be proven; no retry permitted');
  const reject=initial.reasons.includes('provider_rejected') && !initial.responseAccepted && definitiveNativeRejection(evidence);
  if(!reject && !initial.responseAccepted)return {confirmed:false,uncertain:true,noRetry:true,reasons:initial.reasons};
  const directory=path.join(evidence.proofDir,`reconciliation-${randomUUID()}`);
  fs.mkdirSync(directory,{mode:0o700});
  ledger.event(id,'internshala-reconciliation-started',{attempt:attempt.id,directory});
  persist(path.join(directory,'original-native-capture.json'),evidence.har);
  if(reject) {
    persist(path.join(directory,'inspection.json'),initial);
    const receipt={kind:'form-rejected',provider:'internshala',reference:`internshala-rejected:${attempt.id}:${initial.evidenceSha256}`,sourceUrl:job.url,evidencePath:path.join(directory,'inspection.json'),evidenceSha256:initial.evidenceSha256,noRetry:true,at:new Date().toISOString()};
    persist(path.join(directory,'rejected-receipt.json'),receipt);
    ledger.transaction(()=>{
      const current=ledger.job(id),original=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
      if(!ledger.ownsLock() || original.outcome!=='intent' || !['submitting','uncertain'].includes(current.state) || current.payload.internshalaIntentSha256!==job.payload.internshalaIntentSha256)throw Error('Native attempt changed during rejection reconciliation');
      ledger.db.prepare("UPDATE attempts SET outcome='rejected',receipt=? WHERE job_id=? AND outcome='intent'").run(JSON.stringify(receipt),id);
      const payload={...current.payload,internshalaRejectionProofDir:directory,noRetry:true,reasons:['Provider definitively rejected the original application. No application credit; never resubmit.']};
      ledger.db.prepare("UPDATE jobs SET state='exception',payload=?,updated=? WHERE id=?").run(JSON.stringify(payload),new Date().toISOString(),id);
      ledger.event(id,'form-rejected',{attempt:attempt.id,receipt});
    });
    return {confirmed:false,rejected:true,noRetry:true,receipt};
  }
  let history;
  if(historySnapshot) {
    if(typeof historySnapshot!=='function')throw Error('Read-only native history callback required');
    history=await historySnapshot({phase:'after',page,sourceUrl:job.url,before});
  } else {
    // Reuse preserved history after a crash between evidence save and ledger
    // confirmation. Without new evidence, never guess that a POST succeeded.
    const previous=job.payload.internshalaReceiptProofDir || evidence.proofDir;
    try {history=evidence.read(path.join(previous,'history.json'));}catch(error){if(error.code!=='ENOENT')throw error;return {confirmed:false,uncertain:true,noRetry:true,reasons:['Exact provider history evidence is missing']};}
  }
  persist(path.join(directory,'history.json'),history);
  verifyInternshalaHistoryBinding({ledger,id,intent,history});
  const inspected=inspectOriginal(evidence,history);
  persist(path.join(directory,'inspection.json'),inspected);
  if(!inspected.receiptCertified)return {confirmed:false,uncertain:true,noRetry:true,reasons:inspected.reasons};
  const receipt={kind:'form-confirmation',provider:'internshala',reference:`internshala:${inspected.receipt.applicationId}`,sourceUrl:job.url,evidencePath:path.join(directory,'inspection.json'),evidenceSha256:inspected.evidenceSha256,at:new Date().toISOString()};
  persist(path.join(directory,'receipt.json'),receipt);
  ledger.update(id,job.state,{internshalaReceiptProofDir:directory});
  verifyInternshalaApplicationReceipt({ledger,id});
  ledger.receipt(id,receipt);
  await syncReceipt(root,ledger,id);
  return {confirmed:true,receipt};
}
