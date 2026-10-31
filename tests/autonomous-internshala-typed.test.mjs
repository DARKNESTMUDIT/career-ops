import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SANKAR_NATIVE_SLUG,HUMANHIRE_NATIVE_SLUG,internshalaNativeContract,nativeQuestionSchema} from '../autonomous/internshala-contracts.mjs';
import {validateInternshalaFormObservation,planInternshalaNativeSubmission} from '../autonomous/internshala-transport.mjs';
import {validateInternshalaApplicationAnswers} from '../autonomous/internshala-application.mjs';
import {INTERNSHALA_SUBMIT_CONTRACT,inspectInternshalaReceipt,intentDigest} from '../autonomous/internshala-receipts.mjs';
import {adapterFor} from '../autonomous/browser.mjs';
import {authorizeSubmission} from '../autonomous/rollout.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(kind='sankar') {
 const slug=kind==='sankar'?SANKAR_NATIVE_SLUG:HUMANHIRE_NATIVE_SLUG,sourceUrl=`https://internshala.com/internship/detail/${slug}`,contract=internshalaNativeContract(sourceUrl);
 const sources={'cv.md':'Claude, ChatGPT','config/profile.yml':'immediate\nworking_laptop_and_reliable_internet: true\nproject_management_self_rating: 4\n  project_management_rating_scale: 5\ncomfortable_working_night_shifts: false','modes/_profile.md':'Synthetic fixture only'};
 const context={sources,profile:{application_answers:{working_laptop_and_reliable_internet:true,project_management_self_rating:4,project_management_rating_scale:5,comfortable_working_night_shifts:false},candidate:{portfolio_url:'https://portfolio.example.invalid/'},availability:{remote:{earliest_start:'immediate',workplace:'remote'}}}};
 const answer=(value,source='cv.md',quote=value)=>({value,source,quote,sourceSha256:sha(sources[source])});
 const answers={reviewed:true,fields:{confirm_availability:answer('yes','config/profile.yml','immediate')}};
 for(const question of contract.questions) {const rating=question.answerKind==='primary-rating';const value=rating?'4':kind==='sankar'?'Yes':'No';answers.fields[question.name]={...answer(value,'config/profile.yml',rating?'project_management_self_rating: 4\n  project_management_rating_scale: 5':`${question.primaryKey}: ${kind==='sankar'?'true':'false'}`),mapping:question.mapping};}

 const hidden={internshipId:slug,source:'easy_apply_modal',csrf_test_name:'SYNTHETIC',is_sequential_apply_flow:'',sequential_apply_referral:'similar_internships',last_applied_application_id:'',last_applied_job_profile:'',current_job_profile:contract.role,prefilled_custom_resume:''};
 const controls=Object.entries(hidden).map(([name,value])=>({name,value,tag:'input',type:'hidden'}));
 controls.push(...['yes','no','serving-notice','to-serve-notice'].map(value=>({name:'confirm_availability',value,type:'radio',tag:'input'})),{name:'last_working_date',tag:'input',type:'text'},{name:'confirm_availability_textarea',tag:'textarea',type:'textarea'}, {name:'notice_period',tag:'select',options:['15','30','60','90','90+'].map(value=>({value,disabled:false}))},{name:'custom_resume',id:'custom_resume',type:'file'}, {name:'submit',id:'submit',type:'submit',value:'Submit'},...contract.questions.flatMap(q=>q.type==='radio'?q.options.map(o=>({name:q.name,id:`${o.value}_${q.name}`,tag:q.tag,type:q.type,customQuestion:true,questionLabel:q.label,questionRequired:true,value:o.value,optionLabel:o.label,disabled:false})):[{name:q.name,id:q.name,tag:q.tag,type:q.type,customQuestion:true,questionLabel:q.label,questionRequired:true,options:q.options}]));
 const outerHTML=`<form id="application-form"><input value="${slug}"></form>`;
 const observation={url:sourceUrl,jobUrl:slug,scriptUrl:`https://internshala.com/static/js/application/${INTERNSHALA_SUBMIT_CONTRACT.script}`,formId:'application-form',method:'post',controls,outerHTML,explanationMaxLength:2048};
 const pdfBytes=Buffer.from('%PDF-synthetic-only');
 const input={observation,sourceUrl,answers,approvedSources:Object.keys(sources),sourceProofs:Object.fromEntries(Object.entries(sources).map(([name,value])=>[name,{sha256:sha(value)}])),pdf:{fieldName:'custom_resume',filename:'resume.pdf',size:pdfBytes.length,sha256:sha(pdfBytes),frozenBeforeIntent:true},nativeForm:{contract:contract.id,pdfPartCount:2,questionSchema:nativeQuestionSchema(contract),formArtifact:{path:'/synthetic/form',sha256:sha(outerHTML)},scriptArtifact:{path:'/synthetic/script',sha256:INTERNSHALA_SUBMIT_CONTRACT.sha256},scriptAttestation:{path:'/synthetic/manifest',sha256:sha('manifest')}}};
 return {input,context,pdfBytes,answer,sourceUrl,contract};
}

for(const kind of ['sankar','humanhire']) {
 test(`${kind}: certified source cannot enable another form`,()=>{
  const {sourceUrl,contract}=fixture(kind);assert.equal(contract.liveValidated,true);assert.equal(adapterFor(sourceUrl),'internshala');assert.equal(adapterFor(sourceUrl+'?x=1'),null);
  assert.throws(()=>authorizeSubmission({job:()=>({url:sourceUrl+'?unreviewed=1'}),jobs:()=>{throw Error('unreachable');}},'fixture',{},'internshala'),/certification scope/);
 });
 test(`${kind}: exact question radio count, label, option labels/values and type are required`,()=>{
  const {input,sourceUrl}=fixture(kind);validateInternshalaFormObservation(input.observation,sourceUrl);
  for(const mutate of [o=>o.controls.at(-1).questionLabel+='changed',o=>o.controls.at(-1).questionRequired=false,o=>o.controls.at(-1).type='text',o=>o.controls.pop(),o=>o.controls.push({...o.controls.at(-1)}),o=>o.controls.find(c=>c.customQuestion&&c.type==='radio').value='Unknown',o=>o.controls.find(c=>c.customQuestion&&c.type==='radio').optionLabel='changed']){const o=structuredClone(input.observation);mutate(o);assert.throws(()=>validateInternshalaFormObservation(o,sourceUrl));}
  if(kind==='sankar')for(const mutate of [c=>c.options.pop(),c=>c.options[0].disabled=false,c=>c.options[2].label='two',c=>c.options[2].value='20']){const o=structuredClone(input.observation);mutate(o.controls.find(c=>c.name==='custom_question_range_11'));assert.throws(()=>validateInternshalaFormObservation(o,sourceUrl));}
 });
 test(`${kind}: booleans use explicit typed primary mappings and quoted current provenance`,()=>{
  const {input,context,sourceUrl,contract}=fixture(kind),job={sourceUrl,track:'remote'};validateInternshalaApplicationAnswers({context,job,answers:input.answers});
  const question=contract.questions[0];
  for(const mutate of [a=>a.fields[question.name].value=kind==='sankar'?'No':'Yes',a=>a.fields[question.name].mapping='truthy',a=>a.fields[question.name].quote='true',a=>a.fields[question.name].sourceSha256=sha('stale')]){const answers=structuredClone(input.answers);mutate(answers);assert.throws(()=>validateInternshalaApplicationAnswers({context,job,answers}));}
  const changed=structuredClone(context);changed.profile.application_answers[question.primaryKey]=kind==='sankar'?'true':'false';assert.throws(()=>validateInternshalaApplicationAnswers({context:changed,job,answers:input.answers}));
  if(kind==='sankar')for(const mutate of [c=>c.profile.application_answers.project_management_self_rating='4',c=>c.profile.application_answers.project_management_self_rating=6,c=>c.profile.application_answers.project_management_rating_scale=10]){const changed=structuredClone(context);mutate(changed);assert.throws(()=>validateInternshalaApplicationAnswers({context:changed,job,answers:input.answers}));}
 });
 test(`${kind}: sealed planning requires valid mapped options and unchanged question schema`,()=>{
  const {input}=fixture(kind);planInternshalaNativeSubmission(input);
  for(const mutate of [i=>i.nativeForm.questionSchema[0].options[0].value='changed',i=>i.answers.fields[Object.keys(i.answers.fields)[1]].mapping='other',i=>i.answers.fields[Object.keys(i.answers.fields)[1]].value='Unknown',i=>i.nativeForm.scriptArtifact.sha256=sha('changed'),i=>i.pdf.frozenBeforeIntent=false]){const i=structuredClone(input);mutate(i);assert.throws(()=>planInternshalaNativeSubmission(i));}
 });
}
