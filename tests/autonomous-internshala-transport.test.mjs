import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {ARH_NATIVE_CONTRACT,ARH_NATIVE_SLUG,INTERNSHALA_PREFILLED_RESUME_SELECTOR,validateInternshalaFormObservation,planInternshalaNativeSubmission,prepareInternshalaNativeSubmission,installInternshalaScriptAttestation,assertInternshalaScriptAttestation} from '../autonomous/internshala-transport.mjs';
import {chromium} from 'playwright';
import {intentDigest,inspectInternshalaReceipt,INTERNSHALA_SUBMIT_CONTRACT} from '../autonomous/internshala-receipts.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const sourceUrl=`https://internshala.com/internship/detail/${ARH_NATIVE_SLUG}`;
const pdfBytes=Buffer.from('%PDF-1.4\nsynthetic only\n%%EOF\n');
function fixture() {
  const hidden={internshipId:ARH_NATIVE_SLUG,source:'easy_apply_modal',csrf_test_name:'SYNTHETIC-NOT-A-REAL-TOKEN',is_sequential_apply_flow:'',sequential_apply_referral:'similar_internships',last_applied_application_id:'',last_applied_job_profile:'',current_job_profile:'General Management',prefilled_custom_resume:'123456'};
  const controls=Object.entries(hidden).map(([name,value])=>({name,value,type:'hidden',tag:'input'}));
  controls.push(...['yes','serving-notice','to-serve-notice','no'].map(value=>({name:'confirm_availability',type:'radio',tag:'input',value})));
  controls.push({name:'last_working_date',type:'text',tag:'input',value:''},{name:'confirm_availability_textarea',tag:'textarea',type:'textarea',value:''},
    {name:'notice_period',tag:'select',type:'select-one',options:['15','30','60','90','90+'].map(value=>({value,disabled:false}))},
    {name:'custom_resume',id:'custom_resume',type:'file',tag:'input'},
    {name:'submit',id:'submit',type:'submit',tag:'input'});
  const outerHTML=`<form id="application-form"><input name="internshipId" value="${ARH_NATIVE_SLUG}"></form>`;
  const observation={url:sourceUrl,jobUrl:ARH_NATIVE_SLUG,scriptUrl:`https://internshala.com/static/js/application/${INTERNSHALA_SUBMIT_CONTRACT.script}`,formId:'application-form',method:'post',controls,outerHTML,explanationMaxLength:1000};
  const sourceSha256=hash('synthetic reviewed primary'),approvedSources=['cv.md'],sourceProofs={'cv.md':{sha256:sourceSha256}};
  const answer=value=>({value,source:'cv.md',sourceSha256});
  const answers={reviewed:true,fields:{confirm_availability:answer('no'),confirm_availability_textarea:answer('Synthetic reviewed availability.')}};
  const pdf={fieldName:'custom_resume',filename:'current.pdf',sha256:hash(pdfBytes),size:pdfBytes.length,frozenBeforeIntent:true};
  const nativeForm={contract:ARH_NATIVE_CONTRACT,pdfPartCount:2,formArtifact:{path:'/synthetic/form.html',sha256:hash(outerHTML)},scriptArtifact:{path:'/synthetic/script.js',sha256:INTERNSHALA_SUBMIT_CONTRACT.sha256},scriptAttestation:{path:'/synthetic/original-script-response.json',sha256:hash('synthetic manifest: no runtime attestation or application credit')}};
  const input={observation,sourceUrl,answers,approvedSources,sourceProofs,pdf,nativeForm};
  return {input,answer};
}
test('observed ARH schema refuses extra questions, fields, changed role, or changed flow',()=>{
  const {input}=fixture();
  assert.equal(validateInternshalaFormObservation(input.observation,sourceUrl).identity.slug,ARH_NATIVE_SLUG);
  for(const mutate of [o=>o.controls.push({name:'new_question',type:'text',tag:'input'}),o=>o.controls.push({name:'',type:'text',tag:'input'}),o=>o.jobUrl='other-role',o=>o.controls.find(c=>c.name==='source').value='unexpected']) {
    const observation=structuredClone(input.observation);mutate(observation);
    assert.throws(()=>validateInternshalaFormObservation(observation,sourceUrl));
  }
});
test('plan binds reviewed answers and exact artifacts; stale saved resume is explicitly cleared',()=>{
  const {input}=fixture(),plan=planInternshalaNativeSubmission(input);
  assert.equal(plan.protocolFields.prefilled_custom_resume.value,'');
  assert.equal(plan.protocolFields.last_working_date.kind,'inactive-empty');
  assert.equal(plan.fields.confirm_availability.value,'no');
  assert.equal(plan.protocolFields.csrf_test_name.value,'SYNTHETIC-NOT-A-REAL-TOKEN');
  for(const mutate of [i=>i.answers.reviewed=false,i=>i.answers.fields.confirm_availability.source='unapproved',i=>delete i.answers.fields.confirm_availability_textarea,i=>i.answers.fields.extra={value:'invented'},i=>i.nativeForm.formArtifact.sha256=hash('changed'),i=>i.pdf.frozenBeforeIntent=false,i=>i.observation.explanationMaxLength=null]) {
    const changed=structuredClone(input);mutate(changed);assert.throws(()=>planInternshalaNativeSubmission(changed));
  }
});
function nativeReceipt(change={}) {
  const {input}=fixture(),plan=planInternshalaNativeSubmission(input);
  const intent={...plan,state:'active',durableReference:'synthetic-attempt',reservedBeforeFirstPII:true,answersReviewed:true,company:'Synthetic company',role:'General Management'};
  const boundary='synthetic-native-boundary',chunks=[];
  const scalar=(name,value)=>{chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));};
  const file=(bytes=pdfBytes)=>chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="custom_resume"; filename="current.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),bytes,Buffer.from('\r\n'));
  scalar(intent.jobIdField,intent.jobId);
  for(const [name,field] of Object.entries({...intent.fields,...intent.protocolFields}))scalar(name,field.value);
  file();if(change.pdfCount!==1)file(change.corruptSecond?Buffer.from('%PDF-stale'):pdfBytes);
  if(change.pdfCount===3)file();
  if(change.duplicateAnswer)scalar('confirm_availability','no');
  if(change.extra)scalar('unknown','');
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body=Buffer.concat(chunks);
  if(change.changeIntent)change.changeIntent(intent);
  return {intent,sealedIntentSha256:intentDigest(intent),har:{log:{entries:[{startedDateTime:'2099-01-01T00:00:00Z',request:{method:'POST',url:`https://internshala.com/application/submit/${ARH_NATIVE_SLUG}`,postData:{mimeType:`multipart/form-data; boundary=${boundary}`,bodyBase64:body.toString('base64'),bodySha256:hash(body)}},response:{status:200,content:{text:'{"success":true}'}}}]}}};
}
test('pinned native protocol accepts exact empty controls and exactly two independently verified identical PDFs',()=>{
  const result=inspectInternshalaReceipt(nativeReceipt());
  assert.equal(result.requestProven,true);assert.equal(result.responseAccepted,true);
  assert.equal(result.receiptCertified,false);assert.deepEqual(result.reasons,['exact_my_applications_card_missing']);
});
test('native duplicate exception refuses one/three files, stale second file, duplicate answer and unknown field',()=>{
  for(const change of [{pdfCount:1},{pdfCount:3},{corruptSecond:true},{duplicateAnswer:true},{extra:true}])assert.equal(inspectInternshalaReceipt(nativeReceipt(change)).requestProven,false);
});
test('two PDF parts remain forbidden without the pinned native contract',()=>{
  const input=nativeReceipt();delete input.intent.nativeForm;delete input.intent.protocolFields;input.sealedIntentSha256=intentDigest(input.intent);
  const result=inspectInternshalaReceipt(input);
  assert.equal(result.requestProven,false);assert.ok(result.reasons.includes('duplicate_form_field'));
});
test('native protocol cannot waive primary provenance, answer review, script pin or explicit empty whitelist',()=>{
  for(const changeIntent of [i=>i.answersReviewed=false,i=>i.nativeForm.scriptArtifact.sha256=hash('other script'),i=>i.protocolFields.unknown={value:'',kind:'inactive-empty'},i=>i.protocolFields.confirm_availability_textarea={value:'',kind:'inactive-empty'},i=>i.fields.confirm_availability.source='unapproved',i=>delete i.protocolFields.last_working_date])assert.equal(inspectInternshalaReceipt(nativeReceipt({changeIntent})).requestProven,false);
});
test('preparation refuses missing intent before invoking browser or capture',async()=>{
  let touched=false;
  await assert.rejects(prepareInternshalaNativeSubmission({evaluate(){touched=true;}},{ledger:{dir:'/not-real'},intentFile:'/not-real/intent.json',captureFactory(){touched=true;}}));
  assert.equal(touched,false);
});
test('saved resume selector locates the native named hidden control without an id',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<form id="application-form"><input type="hidden" name="prefilled_custom_resume" value="synthetic-stale-id"></form><input name="prefilled_custom_resume" value="unrelated">');
    const control=page.locator(INTERNSHALA_PREFILLED_RESUME_SELECTOR);
    assert.equal(await control.count(),1);
    assert.equal(await control.getAttribute('id'),null);
    await control.evaluate(element=>{element.value='';});
    assert.equal(await control.inputValue(),'');
    assert.equal(await page.locator('body > input').inputValue(),'unrelated');
  } finally {await browser.close();}
});
test('a reconstructed script manifest cannot forge a page-bound original response',()=>{
  const {input}=fixture();
  assert.throws(()=>assertInternshalaScriptAttestation({url:()=>sourceUrl},{sourceUrl,nativeForm:input.nativeForm},'/synthetic'),/Page-bound original/);
});
test('original-script observer refuses a changed actual response before creating proof',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-script-proof-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const page=new EventEmitter(),frame={},directory=path.join(root,'observation');
  let current='about:blank';
  page.url=()=>current;page.mainFrame=()=>frame;
  const observer=installInternshalaScriptAttestation(page,{sourceUrl,directory,root});
  t.after(()=>observer.stop());
  const navigation={frame:()=>frame,isNavigationRequest:()=>true,url:()=>sourceUrl,method:()=> 'GET'};
  page.emit('request',navigation);current=sourceUrl;
  const script={frame:()=>frame,isNavigationRequest:()=>false,url:()=>inputScriptUrl(),method:()=> 'GET',resourceType:()=> 'script',redirectedFrom:()=>null};
  page.emit('request',script);
  page.emit('response',{request:()=>script,status:()=>200,url:()=>inputScriptUrl(),fromServiceWorker:()=>false,body:async()=>Buffer.from('changed synthetic script, never provider bytes')});
  await assert.rejects(observer.wait(),/attestation failed/);
  assert.deepEqual(fs.readdirSync(directory),[]);
  assert.throws(()=>assertInternshalaScriptAttestation(page,{sourceUrl,nativeForm:{}},root),/Page-bound original/);
});
function inputScriptUrl(){return `https://internshala.com/static/js/application/${INTERNSHALA_SUBMIT_CONTRACT.script}`;}
