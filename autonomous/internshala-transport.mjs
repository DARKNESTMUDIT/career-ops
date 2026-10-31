import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {internshipIdentity,intentDigest,INTERNSHALA_SUBMIT_CONTRACT} from './internshala-receipts.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const ARH_NATIVE_CONTRACT='arh-easy-apply-v1';
export const ARH_NATIVE_SLUG='work-from-home-general-management-internship-at-arh-tubes-and-profiles-pvt-ltd1792564453';
export const INTERNSHALA_PREFILLED_RESUME_SELECTOR='#application-form [name="prefilled_custom_resume"]';
const scriptUrl=`https://internshala.com/static/js/application/${INTERNSHALA_SUBMIT_CONTRACT.script}`;
const hiddenNames=['internshipId','source','csrf_test_name','is_sequential_apply_flow','sequential_apply_referral','last_applied_application_id','last_applied_job_profile','current_job_profile','prefilled_custom_resume'];
const names=[...hiddenNames,'confirm_availability','last_working_date','notice_period','confirm_availability_textarea','custom_resume','submit'];
const scriptAttestations=new WeakMap();

function durablePrivate(file,bytes) {
  const fd=fs.openSync(file,'wx',0o600);
  try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  const dir=fs.openSync(path.dirname(file),'r');
  try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
  return {path:file,sha256:sha(bytes)};
}

// Install before the original document navigation. This observes the actual
// script resource response used by this page; it never re-fetches a URL, reads
// headers/cookies, or accepts a caller-provided attestation object as proof.
export function installInternshalaScriptAttestation(page,{sourceUrl,directory,root}={}) {
  if(internshipIdentity(sourceUrl)?.slug!==ARH_NATIVE_SLUG || page.url()===sourceUrl || scriptAttestations.has(page))throw Error('Attestation must precede exact source navigation');
  const base=fs.realpathSync(root),parent=fs.realpathSync(path.dirname(directory));
  if(!parent.startsWith(base+path.sep) && parent!==base)throw Error('Private script evidence directory required');
  fs.mkdirSync(directory,{mode:0o700});
  let resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  ready.catch(()=>{});
  const state={sourceUrl,navigation:null,scriptRequest:null,verified:false,invalid:false,evidence:null};
  scriptAttestations.set(page,state);
  const invalidate=()=>{state.invalid=true;state.verified=false;rejectReady(Error('Original native script attestation failed'));};
  const onRequest=request=>{
    try {
      if(request.frame()!==page.mainFrame())return;
      if(request.isNavigationRequest()) {
        if(state.navigation || request.url()!==sourceUrl || request.method()!=='GET')return invalidate();
        state.navigation=request;return;
      }
      if(request.url()!==scriptUrl)return;
      if(state.invalid || !state.navigation || state.scriptRequest || request.method()!=='GET' || request.resourceType()!=='script' || request.redirectedFrom())return invalidate();
      state.scriptRequest=request;
    } catch {invalidate();}
  };
  const onResponse=response=>{
    if(response.request()!==state.scriptRequest)return;
    (async()=>{
      if(state.invalid || response.status()!==200 || response.url()!==scriptUrl || response.fromServiceWorker())throw Error('Unverified original script response');
      const bytes=await response.body();
      if(state.invalid || bytes.length>262144 || sha(bytes)!==INTERNSHALA_SUBMIT_CONTRACT.sha256 || page.url()!==sourceUrl)throw Error('Original native script bytes differ');
      const scriptArtifact=durablePrivate(path.join(directory,INTERNSHALA_SUBMIT_CONTRACT.script),bytes);
      const manifest={version:1,sourceUrl,scriptUrl,status:200,resourceType:'script',observedAt:new Date().toISOString(),scriptArtifact};
      const scriptAttestation=durablePrivate(path.join(directory,'original-script-response.json'),Buffer.from(JSON.stringify(manifest,null,2)));
      if(state.invalid)throw Error('Page changed during original script observation');
      state.evidence={scriptArtifact,scriptAttestation};state.verified=true;resolveReady(structuredClone(state.evidence));
    })().catch(invalidate);
  };
  const onFailed=request=>{if(request===state.scriptRequest || request===state.navigation)invalidate();};
  page.on('request',onRequest);page.on('response',onResponse);page.on('requestfailed',onFailed);page.on('close',invalidate);
  return {
    async wait({timeoutMs=20000}={}) {
      let timer;
      try {return await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>{invalidate();reject(Error('Original native script response not observed'));},timeoutMs);})]);}
      finally {clearTimeout(timer);}
    },
    stop() {
      invalidate();page.off('request',onRequest);page.off('response',onResponse);page.off('requestfailed',onFailed);page.off('close',invalidate);scriptAttestations.delete(page);
    },
  };
}

export function assertInternshalaScriptAttestation(page,intent,root) {
  const state=scriptAttestations.get(page),native=intent?.nativeForm;
  if(!state?.verified || state.invalid || page.url()!==state.sourceUrl || intent.sourceUrl!==state.sourceUrl || !same(state.evidence?.scriptArtifact,native?.scriptArtifact) || !same(state.evidence?.scriptAttestation,native?.scriptAttestation))throw Error('Page-bound original native script attestation required');
  for(const artifact of [native.scriptArtifact,native.scriptAttestation])if(sha(privateBytes(artifact.path,root))!==artifact.sha256)throw Error('Original native script evidence changed');
  return {verified:true,sourceUrl:state.sourceUrl,sha256:native.scriptArtifact.sha256};
}

// This schema is intentionally bounded to the authenticated ARH form actually
// observed on 2026-10-31. A changed/new question requires another observation.
export function validateInternshalaFormObservation(observation,sourceUrl) {
  const identity=internshipIdentity(sourceUrl);
  if(!identity || identity.slug!==ARH_NATIVE_SLUG || observation?.url!==sourceUrl || observation.jobUrl!==identity.slug || observation.scriptUrl!==scriptUrl)throw Error('Observed native role or script mismatch');
  if(observation.formId!=='application-form' || observation.method!=='post' || !Array.isArray(observation.controls))throw Error('Native form contract changed');
  const controls=observation.controls;
  for(const control of controls) {
    if(!control.name) {
      if(!((control.tag==='button' && control.type==='button' && control.frameClose) || (control.tag==='input' && control.type==='text' && control.chosenSearch)))throw Error('Unknown unnamed native control');
      continue;
    }
    if(!names.includes(control.name) || control.disabled || control.customQuestion)throw Error('Unknown or changed native control');
  }
  const one=name=>{
    const found=controls.filter(control=>control.name===name);
    if(found.length!==1)throw Error('Missing or repeated native control');
    return found[0];
  };
  for(const name of hiddenNames)if(one(name).type!=='hidden')throw Error('Hidden protocol control changed');
  const hidden=Object.fromEntries(hiddenNames.map(name=>[name,one(name).value]));
  if(hidden.internshipId!==identity.slug || hidden.source!=='easy_apply_modal' || hidden.current_job_profile!=='General Management' || hidden.sequential_apply_referral!=='similar_internships' || !hidden.csrf_test_name || ['is_sequential_apply_flow','last_applied_application_id','last_applied_job_profile'].some(name=>hidden[name]!==''))throw Error('Native hidden identity or flow changed');
  if(hidden.prefilled_custom_resume!=='' && !/^\d+$/.test(hidden.prefilled_custom_resume))throw Error('Unexpected saved resume reference');
  const radios=controls.filter(control=>control.name==='confirm_availability');
  if(radios.length!==4 || radios.some(control=>control.type!=='radio') || JSON.stringify(radios.map(control=>control.value).sort())!==JSON.stringify(['no','serving-notice','to-serve-notice','yes'].sort()))throw Error('Availability choices changed');
  if(one('last_working_date').type!=='text' || one('confirm_availability_textarea').tag!=='textarea' || one('notice_period').tag!=='select')throw Error('Availability controls changed');
  if(JSON.stringify(one('notice_period').options?.filter(option=>!option.disabled).map(option=>option.value))!==JSON.stringify(['15','30','60','90','90+']))throw Error('Notice-period options changed');
  if(one('custom_resume').type!=='file' || one('custom_resume').id!=='custom_resume' || one('custom_resume').multiple || one('submit').type!=='submit' || one('submit').id!=='submit')throw Error('Native resume or submit control changed');
  return {identity,hidden};
}

export async function inspectInternshalaNativeForm(page,{sourceUrl}={}) {
  if(page.url()!==sourceUrl)throw Error('Exact native source page required');
  if(await page.locator('form#application-form').count()!==1 || !await page.locator('form#application-form').isVisible())throw Error('Caller must open the visible native application form before observation');
  const observation=await page.evaluate(scriptUrl=>{
    const forms=document.querySelectorAll('form#application-form');
    if(forms.length!==1 || [...document.scripts].filter(script=>script.src===scriptUrl).length!==1)throw Error('Native form or script missing or ambiguous');
    const form=forms[0];
    return {url:location.href,jobUrl:typeof job_url==='string'?job_url:null,scriptUrl,
      formId:form.id,method:form.method.toLowerCase(),outerHTML:form.outerHTML,
      controls:[...form.elements].map(control=>({name:control.name,tag:control.tagName.toLowerCase(),type:control.type,id:control.id,value:control.type==='file'?'':control.value,
        disabled:control.disabled,multiple:control.multiple===true,customQuestion:control.classList.contains('custom-question-answer'),frameClose:control.classList.contains('frame-close'),chosenSearch:control.classList.contains('chosen-search-input'),
        options:control.tagName==='SELECT'?[...control.options].map(option=>({value:option.value,disabled:option.disabled})):null})),
      explanationMaxLength:typeof maxLength==='number'?maxLength:null};
  },scriptUrl);
  validateInternshalaFormObservation(observation,sourceUrl);
  if(page.url()!==sourceUrl)throw Error('Source changed during observation');
  return observation; // Secret-bearing: persist privately; never log this object.
}

function privateBytes(file,root) {
  const resolved=fs.realpathSync(file),base=fs.realpathSync(root),stat=fs.statSync(resolved);
  if(!resolved.startsWith(base+path.sep) || !stat.isFile() || (stat.mode&0o077))throw Error('Private native artifact required');
  return fs.readFileSync(resolved);
}

export function validateInternshalaNativeArtifacts(intent,root) {
  const native=intent?.nativeForm;
  if(native?.contract!==ARH_NATIVE_CONTRACT || native.pdfPartCount!==2 || native.scriptArtifact?.sha256!==INTERNSHALA_SUBMIT_CONTRACT.sha256)throw Error('Pinned native form contract required');
  for(const artifact of [native.scriptArtifact,native.formArtifact,native.scriptAttestation]) {
    if(typeof artifact?.path!=='string' || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '') || sha(privateBytes(artifact.path,root))!==artifact.sha256)throw Error('Native artifact changed');
  }
  const form=privateBytes(native.formArtifact.path,root).toString('utf8');
  if(!form.includes('id="application-form"') || !form.includes(`value="${ARH_NATIVE_SLUG}"`))throw Error('Native form artifact identity mismatch');
  const manifest=JSON.parse(privateBytes(native.scriptAttestation.path,root).toString('utf8'));
  if(manifest.version!==1 || manifest.sourceUrl!==intent.sourceUrl || manifest.scriptUrl!==scriptUrl || manifest.status!==200 || manifest.resourceType!=='script' || !same(manifest.scriptArtifact,native.scriptArtifact))throw Error('Original native script manifest mismatch');
  return {formHtml:form};
}

// Returns exact expected successful scalar controls. Browser-generated protocol
// fields stay separate from reviewed primary-backed candidate answers.
export function planInternshalaNativeSubmission({observation,sourceUrl,answers,approvedSources,sourceProofs,pdf,nativeForm}={}) {
  const {identity,hidden}=validateInternshalaFormObservation(observation,sourceUrl);
  if(answers?.reviewed!==true || !answers.fields || !Array.isArray(approvedSources))throw Error('Explicitly reviewed primary answers required');
  const fields={...answers.fields};
  const availability=fields.confirm_availability?.value;
  if(!['yes','no','serving-notice','to-serve-notice'].includes(availability))throw Error('Reviewed availability required');
  const needed=['confirm_availability',...(availability==='no'?['confirm_availability_textarea']:availability==='serving-notice'?['last_working_date']:availability==='to-serve-notice'?['notice_period']:[])];
  if(Object.keys(fields).length!==needed.length || Object.keys(fields).some(name=>!needed.includes(name)))throw Error('Missing or unexpected reviewed answer');
  for(const field of Object.values(fields))if(typeof field.value!=='string' || !field.value.trim() || !approvedSources.includes(field.source) || !/^[a-f0-9]{64}$/.test(field.sourceSha256 ?? '') || sourceProofs?.[field.source]?.sha256!==field.sourceSha256)throw Error('Answer lacks approved primary provenance');
  if(availability==='serving-notice' && !/^\d{4}-\d{2}-\d{2}$/.test(fields.last_working_date.value))throw Error('Exact reviewed joining date required');
  if(availability==='to-serve-notice' && !['15','30','60','90','90+'].includes(fields.notice_period.value))throw Error('Unsupported notice period');
  if(availability==='no' && (!Number.isSafeInteger(observation.explanationMaxLength) || observation.explanationMaxLength<=0 || fields.confirm_availability_textarea.value.length>observation.explanationMaxLength))throw Error('Observed availability explanation limit required');
  if(pdf?.fieldName!=='custom_resume' || !/^[^/\\\r\n]+\.pdf$/i.test(pdf.filename ?? '') || !Number.isSafeInteger(pdf.size) || pdf.size<=0 || pdf.size>10485760 || !/^[a-f0-9]{64}$/.test(pdf.sha256 ?? '') || pdf.frozenBeforeIntent!==true)throw Error('Frozen current PDF required');
  if(nativeForm?.contract!==ARH_NATIVE_CONTRACT || nativeForm.pdfPartCount!==2 || nativeForm.formArtifact?.sha256!==sha(Buffer.from(observation.outerHTML ?? '')) || nativeForm.scriptArtifact?.sha256!==INTERNSHALA_SUBMIT_CONTRACT.sha256 || !/^[a-f0-9]{64}$/.test(nativeForm.scriptAttestation?.sha256 ?? '') || !nativeForm.scriptAttestation?.path)throw Error('Exact observed native artifacts required');
  const protocolFields=Object.fromEntries(Object.entries(hidden).filter(([name])=>name!=='internshipId').map(([name,value])=>[name,{value:name==='prefilled_custom_resume'?'':value,kind:'observed-hidden'}]));
  for(const name of ['last_working_date','confirm_availability_textarea'])if(!fields[name])protocolFields[name]={value:'',kind:'inactive-empty'};
  return {sourceUrl,jobId:identity.slug,jobIdField:'internshipId',fields,protocolFields,pdf,nativeForm,approvedSources,sourceProofs};
}

function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}

// captureFactory must be the existing guarded capture component. Injection
// avoids a circular import when that component independently rechecks artifacts.
// Intent creation/reservation and canonical receipt/tracker sync belong to the
// caller. No retry is supplied, even if clicking loses its response.
export async function prepareInternshalaNativeSubmission(page,options) {
  const {ledger,id,intentFile,sealedIntentSha256,pdfPath,captureFactory}=options;
  const assertIntent=()=>{
    const intent=JSON.parse(privateBytes(intentFile,ledger.dir).toString('utf8'));
    const attempt=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id),job=ledger.job(id);
    if(!ledger.ownsLock() || ledger.get('paused') || ledger.get('integrityFailure') || job?.state!=='submitting' || attempt?.outcome!=='intent' || attempt.id!==intent.durableReference || intent.reservedBeforeFirstPII!==true || intent.answersReviewed!==true || intent.state!=='active' || intentDigest(intent)!==sealedIntentSha256 || job.payload.internshalaIntentSha256!==sealedIntentSha256 || intent.sourceUrl!==job.url)throw Error('Active sealed durable intent required');
    validateInternshalaNativeArtifacts(intent,ledger.dir);
    assertInternshalaScriptAttestation(page,intent,ledger.dir);
    const bytes=privateBytes(pdfPath,ledger.dir);
    if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')) || sha(bytes)!==intent.pdf?.sha256 || bytes.length!==intent.pdf?.size)throw Error('Current frozen PDF changed');
    return {intent,bytes};
  };
  const {intent,bytes}=assertIntent();
  const observed=await inspectInternshalaNativeForm(page,{sourceUrl:intent.sourceUrl});
  const plan=planInternshalaNativeSubmission({observation:observed,sourceUrl:intent.sourceUrl,answers:{reviewed:true,fields:intent.fields},approvedSources:intent.approvedSources,sourceProofs:intent.sourceProofs,pdf:intent.pdf,nativeForm:intent.nativeForm});
  for(const name of ['jobId','jobIdField','fields','protocolFields','pdf','nativeForm'])if(!same(plan[name],intent[name]))throw Error('Native plan differs from sealed intent');
  if(typeof captureFactory!=='function')throw Error('Guarded capture factory required');
  // Installation precedes even hidden-field changes and local file selection.
  const capture=await captureFactory(page,options);
  let used=false;
  try {
    await page.locator(INTERNSHALA_PREFILLED_RESUME_SELECTOR).evaluate(control=>{control.value='';control.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.locator(`#application-form input[name="confirm_availability"][value="${intent.fields.confirm_availability.value}"]`).check();
    for(const name of ['confirm_availability_textarea','last_working_date']) {
      const control=page.locator(`#application-form [name="${name}"]`),value=intent.fields[name]?.value ?? '';
      if(name==='last_working_date' && value) {
        // The observed native datepicker owns this readonly control. Use its
        // public API, preserving readonly rather than removing the attribute.
        await control.evaluate((element,value)=>{if(typeof window.jQuery?.fn.datepicker!=='function')throw Error('Native datepicker unavailable');window.jQuery(element).datepicker('setDate',value).trigger('change');},value);
      } else if(value)await control.fill(value);
      else await control.evaluate(element=>{element.value='';element.dispatchEvent(new Event('change',{bubbles:true}));});
    }
    if(intent.fields.notice_period)await page.locator('#application-form #notice_period').selectOption(intent.fields.notice_period.value,{force:true});
    await page.locator('#application-form #custom_resume').setInputFiles({name:intent.pdf.filename,mimeType:'application/pdf',buffer:bytes});
    return {capture,async submit() {
      if(used)throw Error('Native submission is single-use');
      used=true;
      assertIntent();
      const current=await inspectInternshalaNativeForm(page,{sourceUrl:intent.sourceUrl});
      const expected={...Object.fromEntries(Object.entries(intent.protocolFields).map(([name,field])=>[name,field.value])),...Object.fromEntries(Object.entries(intent.fields).map(([name,field])=>[name,field.value])),[intent.jobIdField]:intent.jobId};
      const actual=await page.evaluate(async()=>{
        const form=document.querySelector('#application-form'),fields=[];
        for(const [name,value] of new FormData(form)) {
          if(value instanceof File) {
            const bytes=new Uint8Array(await value.arrayBuffer()),digest=await crypto.subtle.digest('SHA-256',bytes);
            fields.push({name,file:{filename:value.name,size:value.size,type:value.type,sha256:[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')}});
          } else fields.push({name,value});
        }
        return {fields,valid:typeof window.jQuery?.fn.valid==='function' && window.jQuery(form).valid()===true};
      });
      const scalar=actual.fields.filter(field=>!field.file),files=actual.fields.filter(field=>field.file);
      if(!actual.valid || scalar.length!==Object.keys(expected).length || new Set(scalar.map(field=>field.name)).size!==scalar.length || scalar.some(field=>expected[field.name]!==field.value) || files.length!==1 || files[0].name!=='custom_resume' || !same(files[0].file,{filename:intent.pdf.filename,size:intent.pdf.size,type:'application/pdf',sha256:intent.pdf.sha256}) || current.controls.find(control=>control.name==='prefilled_custom_resume')?.value!=='')throw Error('Native filled form or PDF differs from sealed intent');
      // The provider's original handler appends the second identical file.
      // Guarded capture validates both actual wire parts before continuation.
      assertIntent();
      // Start observing before the click. A timeout/error is deliberately not
      // converted into a second click; capture retains deny-mutation protection.
      const responsePromise=page.waitForResponse(response=>response.url()===internshipIdentity(intent.sourceUrl).submitUrl && response.request().method()==='POST',{timeout:30000});
      // Attach rejection handling immediately if the click itself fails first.
      responsePromise.catch(()=>{});
      await page.locator('#application-form input#submit[type="submit"]').click({timeout:15000});
      const response=await responsePromise;
      const finished=await response.finished();
      if(finished)throw Error('Native response did not finish; reconcile existing capture without retry');
      return {submittedControlInvoked:true,responseObserved:true,receiptCertified:false};
    }};
  } catch(error) {
    try {await capture.stop();} catch {}
    throw error;
  }
}
