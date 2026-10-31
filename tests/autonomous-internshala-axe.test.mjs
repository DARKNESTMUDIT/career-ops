import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AXE_NATIVE_SLUG,AXE_NATIVE_CONTRACT,internshalaNativeContract,nativeQuestionSchema} from '../autonomous/internshala-contracts.mjs';
import {validateInternshalaFormObservation,planInternshalaNativeSubmission} from '../autonomous/internshala-transport.mjs';
import {validateInternshalaApplicationAnswers} from '../autonomous/internshala-application.mjs';
import {INTERNSHALA_SUBMIT_CONTRACT,inspectInternshalaReceipt,intentDigest} from '../autonomous/internshala-receipts.mjs';
import {adapterFor} from '../autonomous/browser.mjs';
import {authorizeSubmission} from '../autonomous/rollout.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const sourceUrl=`https://internshala.com/internship/detail/${AXE_NATIVE_SLUG}`,contract=internshalaNativeContract(sourceUrl);
function fixture() {
 const sources={'cv.md':'Claude, ChatGPT','config/profile.yml':'immediate https://portfolio.example.invalid/','modes/_profile.md':'Synthetic fixture only'};
 const context={sources,profile:{candidate:{portfolio_url:'https://portfolio.example.invalid/'},availability:{remote:{earliest_start:'immediate',workplace:'remote'}}}};
 const answer=(value,source='cv.md',quote=value)=>({value,source,quote,sourceSha256:sha(sources[source])});
 const answers={reviewed:true,fields:{confirm_availability:answer('yes','config/profile.yml','immediate'),custom_question_text_7464862:answer('Claude, ChatGPT'),custom_question_text_12:answer('https://portfolio.example.invalid/','config/profile.yml')}};
 const hidden={internshipId:AXE_NATIVE_SLUG,source:'easy_apply_modal',csrf_test_name:'SYNTHETIC',is_sequential_apply_flow:'',sequential_apply_referral:'similar_internships',last_applied_application_id:'',last_applied_job_profile:'',current_job_profile:'Market Research',prefilled_custom_resume:''};
 const controls=Object.entries(hidden).map(([name,value])=>({name,value,tag:'input',type:'hidden'}));
 controls.push(...['yes','no','serving-notice','to-serve-notice'].map(value=>({name:'confirm_availability',value,type:'radio',tag:'input'})),{name:'last_working_date',tag:'input',type:'text'},{name:'confirm_availability_textarea',tag:'textarea',type:'textarea'}, {name:'notice_period',tag:'select',options:['15','30','60','90','90+'].map(value=>({value,disabled:false}))},{name:'custom_resume',id:'custom_resume',type:'file'}, {name:'submit',id:'submit',type:'submit',value:'Submit'},...contract.questions.map(q=>({name:q.name,id:q.name,tag:q.tag,type:q.type,customQuestion:true,questionLabel:q.label,questionRequired:true})));
 const outerHTML=`<form id="application-form"><input value="${AXE_NATIVE_SLUG}"></form>`;
 const observation={url:sourceUrl,jobUrl:AXE_NATIVE_SLUG,scriptUrl:`https://internshala.com/static/js/application/${INTERNSHALA_SUBMIT_CONTRACT.script}`,formId:'application-form',method:'post',controls,outerHTML,explanationMaxLength:2048};
 const pdfBytes=Buffer.from('%PDF-synthetic-only');
 const input={observation,sourceUrl,answers,approvedSources:Object.keys(sources),sourceProofs:Object.fromEntries(Object.entries(sources).map(([name,value])=>[name,{sha256:sha(value)}])),pdf:{fieldName:'custom_resume',filename:'resume.pdf',size:pdfBytes.length,sha256:sha(pdfBytes),frozenBeforeIntent:true},nativeForm:{contract:AXE_NATIVE_CONTRACT,pdfPartCount:2,questionSchema:nativeQuestionSchema(contract),formArtifact:{path:'/synthetic/form',sha256:sha(outerHTML)},scriptArtifact:{path:'/synthetic/script',sha256:INTERNSHALA_SUBMIT_CONTRACT.sha256},scriptAttestation:{path:'/synthetic/manifest',sha256:sha('manifest')}}};
 return {input,context,pdfBytes,answer};
}
test('Axe certification remains exact-source only and cannot grant another role access',()=>{
 assert.equal(adapterFor(sourceUrl),'internshala');assert.equal(contract.liveValidated,true);
 for(const url of [sourceUrl+'?x=1',sourceUrl+'/',sourceUrl.replace('llc179','llc180')])assert.equal(adapterFor(url),null);
 let touched=false;assert.throws(()=>authorizeSubmission({job:()=>({url:sourceUrl+'?unreviewed=1'}),jobs:()=>{touched=true;throw Error('not reached');}},'fixture',{},'internshala'),/certification scope/);assert.equal(touched,false);
});
test('Axe validates exact mandatory question labels, names, types, counts and notice options before preparation',()=>{
 const {input}=fixture();assert.equal(validateInternshalaFormObservation(input.observation,sourceUrl).contract.id,AXE_NATIVE_CONTRACT);
 const mutations=[o=>o.controls.at(-1).questionLabel+=' changed',o=>o.controls.at(-1).questionRequired=false,o=>o.controls.at(-1).customQuestion=false,o=>o.controls.at(-1).tag='input',o=>o.controls.pop(),o=>o.controls.push({...o.controls.at(-1)}),o=>o.controls.push({name:'new_question',tag:'textarea'}),o=>o.controls.find(c=>c.name==='notice_period').options.push({value:'new'}),o=>o.controls.find(c=>c.name==='current_job_profile').value='Other'];
 for(const mutate of mutations){const o=structuredClone(input.observation);mutate(o);assert.throws(()=>validateInternshalaFormObservation(o,sourceUrl));}
 for(const mutate of [i=>i.nativeForm.questionSchema[0].label+='changed',i=>i.nativeForm.scriptArtifact.sha256=sha('changed'),i=>delete i.answers.fields.custom_question_text_12]){const i=structuredClone(input);mutate(i);assert.throws(()=>planInternshalaNativeSubmission(i));}
});
test('Axe answers permit only primary-backed tool familiarity and the existing general portfolio URL',()=>{
 const {input,context,answer}=fixture(),job={sourceUrl,track:'remote'};validateInternshalaApplicationAnswers({context,job,answers:input.answers});
 for(const [name,field] of [['custom_question_text_7464862',answer('Excel')],['custom_question_text_7464862',{...answer('Claude, ChatGPT'),sourceSha256:sha('stale')}],['custom_question_text_12',answer('https://invented.example.invalid/research','config/profile.yml')]]){
  const answers=structuredClone(input.answers);answers.fields[name]=field;assert.throws(()=>validateInternshalaApplicationAnswers({context,job,answers}));
 }
});
test('Axe native receipt requires all sealed answers, question schema, script hash and exactly two matching PDF parts',()=>{
 const {input,pdfBytes}=fixture(),plan=planInternshalaNativeSubmission(input);
 const intent={...plan,state:'active',durableReference:'fixture',reservedBeforeFirstPII:true,answersReviewed:true,company:contract.company,role:contract.role};
 const boundary='fixture',chunks=[];
 for(const [name,value] of [[plan.jobIdField,plan.jobId],...Object.entries({...plan.fields,...plan.protocolFields}).map(([name,f])=>[name,f.value])])chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
 for(let n=0;n<2;n++)chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="custom_resume"; filename="resume.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),pdfBytes,Buffer.from('\r\n'));
 chunks.push(Buffer.from(`--${boundary}--\r\n`));const bytes=Buffer.concat(chunks);
 const har={log:{entries:[{startedDateTime:new Date().toISOString(),request:{method:'POST',url:`https://internshala.com/application/submit/${AXE_NATIVE_SLUG}`,postData:{mimeType:`multipart/form-data; boundary=${boundary}`,bodyBase64:bytes.toString('base64'),bodySha256:sha(bytes)}},response:{status:200,content:{text:'{"success":true}'}}}]}};
 const inspect=i=>inspectInternshalaReceipt({intent:i,sealedIntentSha256:intentDigest(i),har});assert.equal(inspect(intent).requestProven,true);assert.equal(inspect(intent).responseAccepted,true);assert.equal(inspect(intent).receiptCertified,false);
 for(const mutate of [i=>i.nativeForm.questionSchema[0].label+='changed',i=>i.fields.custom_question_text_12.value+='invented',i=>i.nativeForm.scriptArtifact.sha256=sha('changed'),i=>i.pdf.sha256=sha('changed'),i=>i.role='Other']){const i=structuredClone(intent);mutate(i);assert.equal(inspect(i).requestProven,false);}
});
