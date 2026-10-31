import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createHash} from 'node:crypto';
import {INTERNSHALA_HISTORY_VERSION,inspectInternshalaHistorySnapshot,assertInternshalaHistoryBefore,internshalaHistoryDigest,verifyNextReceipt,createInternshalaHistorySnapshot} from '../autonomous/internshala-history.mjs';
import {inspectInternshalaReceipt,intentDigest} from '../autonomous/internshala-receipts.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const sourceUrl='https://internshala.com/internship/detail/work-from-home-general-management-internship-at-example1792564453';
const company='Example Company',role='General Management';
const at=s=>`2026-10-31T12:00:${String(s).padStart(2,'0')}.000Z`;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=','base64');
const row=(id,url=`https://internshala.com/internship/detail/old-role-at-example${id}`)=>({id,url,company_name:'Historical Company',profile_to_display:'Different Role',application_review_url:`https://internshala.com/application/view/${id}`,applied_at:"15 Aug' 26",application_status:'Not Selected'});
function response(type,page,rows,{recent=0,old=3,purpose='page',time=1}={}) {
  const bytes=Buffer.from(JSON.stringify({success:true,recent_application_count:String(recent),old_application_count:String(old),total_pages:0,applications:rows}));
  return {type,page,purpose,url:`https://internshala.com/api/candidate/dashboard/paginated_applications/${type}/${page}?dashboard_source=recent`,status:200,observedAt:at(time),bodyBase64:bytes.toString('base64'),bodySha256:sha(bytes),artifact:{path:`/synthetic/${type}-${page}-${purpose}.json`,sha256:sha(bytes)}};
}
function card(application) {
  return `<div class="flex flex-row items-center text-sm lg:hidden"><div><a href="${application.url}"><span>${application.profile_to_display} Internship</span><div>${application.company_name}</div></a><div>Applied on ${application.applied_at}</div></div><a href="${application.application_review_url}?referral=dashboard"><svg></svg></a></div>`;
}
function ui(application,time) {
  const html=application?card(application):null,pageHtml=`<html><body>${html??'<p>No recent applications</p>'}</body></html>`;
  return {pageUrl:'https://internshala.com/student/applications/?dashboard_source=recent',observedAt:at(time),pageHtml,pageSha256:sha(pageHtml),pageArtifact:{path:'/synthetic/ui.html',sha256:sha(pageHtml)},screenshotBase64:png.toString('base64'),screenshotSha256:sha(png),screenshotArtifact:{path:'/synthetic/ui.png',sha256:sha(png)},card:html?{outerHTML:html,visible:true,sha256:sha(html)}:null};
}
function snapshots() {
  const oldRows=[row(11),row(12),row(13)],application={...row(99,sourceUrl),company_name:company,profile_to_display:role,applied_at:"31 Oct' 26",application_status:'Applied'};
  const make=(phase,start,added)=>({version:INTERNSHALA_HISTORY_VERSION,phase,sourceUrl,startedAt:at(start),completedAt:at(start+9),responses:[response('new',1,added?[application]:[],{recent:added?1:0,time:start+1}),response('old',1,oldRows,{recent:added?1:0,time:start+2}),response('new',1,added?[application]:[],{recent:added?1:0,purpose:'stability',time:start+3}),response('old',1,oldRows,{recent:added?1:0,purpose:'stability',time:start+4})],ui:ui(added?application:null,start+8)});
  const before=make('before',0,false),after=make('after',30,true),intent={sourceUrl,company,role,historyBeforeSha256:internshalaHistoryDigest(before)};
  return {before,after,intent,application,entry:{startedDateTime:at(20)}};
}
function changeData(proof,change) {
  const data=JSON.parse(Buffer.from(proof.bodyBase64,'base64').toString());change(data);const bytes=Buffer.from(JSON.stringify(data));proof.bodyBase64=bytes.toString('base64');proof.bodySha256=sha(bytes);proof.artifact.sha256=sha(bytes);
}
function replaceCard(snapshot,html) {
  snapshot.ui.card.outerHTML=html;snapshot.ui.card.sha256=sha(html);snapshot.ui.pageHtml=`<html><body>${html}</body></html>`;snapshot.ui.pageSha256=sha(snapshot.ui.pageHtml);snapshot.ui.pageArtifact.sha256=snapshot.ui.pageSha256;
}
test('complete observed count/arrays override total_pages zero; all raw history is sealed',()=>{
  const {before,intent}=snapshots();
  assert.equal(inspectInternshalaHistorySnapshot(before).rows.length,3);
  assert.equal(assertInternshalaHistoryBefore(before,intent).verified,true);
  const changed=structuredClone(before);changed.ui.pageHtml+=' ';changed.ui.pageSha256=sha(changed.ui.pageHtml);changed.ui.pageArtifact.sha256=changed.ui.pageSha256;
  assert.notEqual(internshalaHistoryDigest(changed),intent.historyBeforeSha256);
});
test('actual historical consecutive-hyphen slug shape remains an exact provider URL',()=>{
  const {before,intent}=snapshots();
  for(const proof of before.responses.filter(p=>p.type==='old'))changeData(proof,d=>d.applications[0].url='https://internshala.com/internship/detail/ai-ml-research--quantitative-internship-at-example123');
  assert.equal(assertInternshalaHistoryBefore(before,intent).verified,true);
  const unsafe=structuredClone(before);changeData(unsafe.responses[1],d=>d.applications[0].url+='?redirect=evil');assert.throws(()=>inspectInternshalaHistorySnapshot(unsafe));
});
test('exact source or historical company-role duplicate blocks before intent, with bounded employment suffix only',()=>{
  for(const sameSource of [true,false]) {
    const {before,intent}=snapshots();
    for(const proof of before.responses.filter(p=>p.type==='old'))changeData(proof,data=>{if(sameSource)data.applications[0].url=sourceUrl;else{data.applications[0].company_name=company;data.applications[0].profile_to_display=role+' Internship';}});
    assert.throws(()=>assertInternshalaHistoryBefore(before,intent),/do not resend/);
  }
});
test('partial enumeration, count drift, duplicate IDs, missing stability and altered raw bytes cannot prove absence',()=>{
  for(const mutate of [s=>changeData(s.responses[1],d=>d.applications.pop()),s=>changeData(s.responses[3],d=>d.old_application_count='4'),s=>{for(const p of s.responses.filter(p=>p.type==='old'))changeData(p,d=>d.applications[1].id=d.applications[0].id);},s=>s.responses.pop(),s=>s.responses[0].bodyBase64=Buffer.from('{}').toString('base64')]) {
    const {before,intent}=snapshots();mutate(before);assert.throws(()=>assertInternshalaHistoryBefore(before,intent));
  }
});
test('all provider pages must be contiguous and cover count; page1 stability must agree',()=>{
  const {before}=snapshots(),rows=[row(11),row(12),row(13)];
  before.responses=[response('new',1,[],{time:1}),response('old',1,[rows[0]],{time:2}),response('old',2,rows.slice(1),{time:3}),response('new',1,[],{purpose:'stability',time:4}),response('old',1,[rows[0]],{purpose:'stability',time:5})];
  assert.equal(inspectInternshalaHistorySnapshot(before).rows.length,3);
  const skipped=structuredClone(before);skipped.responses[2].page=3;skipped.responses[2].url=skipped.responses[2].url.replace('/old/2','/old/3');assert.throws(()=>inspectInternshalaHistorySnapshot(skipped));
  const changed=structuredClone(before);changeData(changed.responses[4],d=>d.applications[0]=row(14));assert.throws(()=>inspectInternshalaHistorySnapshot(changed));
  const changedIdentity=structuredClone(before);changeData(changedIdentity.responses[4],d=>d.applications[0].url=sourceUrl);assert.throws(()=>inspectInternshalaHistorySnapshot(changedIdentity));
});
test('next receipt binds actual API identity/date to one rendered card, including icon-only review anchor',()=>{
  const f=snapshots(),receipt=verifyNextReceipt(f.before,f.after,f.intent,f.entry);
  assert.equal(receipt.applicationId,'99');assert.equal(receipt.historyVersion,INTERNSHALA_HISTORY_VERSION);
  const html=f.after.ui.card.outerHTML.replace(/<\/div>$/,'<a href="https://internshala.com/application/view/99?referral=dashboard">mobile duplicate same ID</a></div>');replaceCard(f.after,html);
  assert.equal(verifyNextReceipt(f.before,f.after,f.intent,f.entry).applicationId,'99');
});
test('unsealed baseline, old date, wrong company/role, wrong review ID, cross-row parent or invalid PNG stay held',()=>{
  for(const mutate of [f=>delete f.intent.historyBeforeSha256,f=>f.intent.role+=' Intern',f=>f.intent.company+=' Ltd',f=>f.entry.startedDateTime=at(0),f=>{for(const p of f.after.responses.filter(p=>p.type==='new'))changeData(p,d=>d.applications[0].applied_at="30 Oct' 26");},f=>replaceCard(f.after,f.after.ui.card.outerHTML.replace('/view/99','/view/98')),f=>replaceCard(f.after,f.after.ui.card.outerHTML.replace(company,company+' Ltd')),f=>replaceCard(f.after,f.after.ui.card.outerHTML.replace('flex flex-row items-center text-sm lg:hidden','table-parent')),f=>replaceCard(f.after,f.after.ui.card.outerHTML+card(row(55))),f=>f.after.ui.screenshotBase64=Buffer.from('not PNG').toString('base64')]) {
    const f=snapshots();mutate(f);assert.equal(verifyNextReceipt(f.before,f.after,f.intent,f.entry),null);
  }
});
test('versioned history routes directly through native receipt checks; unknown version never falls back to legacy',()=>{
  const f=snapshots(),pdf=Buffer.from('%PDF-synthetic'),primary=sha('synthetic primary');
  const intent={...f.intent,state:'active',durableReference:'synthetic-attempt',reservedBeforeFirstPII:true,jobId:'99',jobIdField:'synthetic_job',approvedSources:['cv.md'],sourceProofs:{'cv.md':{sha256:primary}},fields:{answer:{value:'synthetic answer',source:'cv.md',sourceSha256:primary}},pdf:{fieldName:'resume',filename:'synthetic.pdf',size:pdf.length,sha256:sha(pdf),frozenBeforeIntent:true}};
  const boundary='synthetic-boundary',bytes=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="synthetic_job"\r\n\r\n99\r\n--${boundary}\r\nContent-Disposition: form-data; name="answer"\r\n\r\nsynthetic answer\r\n--${boundary}\r\nContent-Disposition: form-data; name="resume"; filename="synthetic.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),pdf,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const entry={...f.entry,request:{method:'POST',url:sourceUrl.replace('/internship/detail/','/application/submit/'),postData:{mimeType:`multipart/form-data; boundary=${boundary}`,bodyBase64:bytes.toString('base64'),bodySha256:sha(bytes)}},response:{status:200,content:{text:'{"success":true}'}}};
  const input={intent,sealedIntentSha256:intentDigest(intent),har:{log:{entries:[entry]}},history:{version:INTERNSHALA_HISTORY_VERSION,before:f.before,after:f.after}};
  assert.equal(inspectInternshalaReceipt(input).receiptCertified,true,'synthetic semantic verification only, never real application credit');
  entry.response.content.text='{}';assert.equal(inspectInternshalaReceipt(input).receiptCertified,false);entry.response.content.text='{"success":true}';
  input.history.version='next-history@99';assert.equal(inspectInternshalaReceipt(input).receiptCertified,false);
});
test('snapshot collector calls only observed read API with existing context jar and preserves application page',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-fixture-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[],routes=[];let historyUrl;
  const context={request:{async post(url,options){calls.push({url,options});const bytes=Buffer.from(JSON.stringify({success:true,recent_application_count:'0',old_application_count:'0',total_pages:0,applications:[]}));return {status:()=>200,body:async()=>bytes};}},async newPage(){return {route:async(_,handler)=>routes.push(handler),goto:async url=>{historyUrl=url;},url:()=>historyUrl,content:async()=>'<html><body>No applications</body></html>',screenshot:async()=>png,close:async()=>{}};}};
  const page={url:()=>sourceUrl,context:()=>context};
  const snapshot=await createInternshalaHistorySnapshot({directory:path.join(root,'history'),root})({phase:'before',page,sourceUrl});
  assert.equal(inspectInternshalaHistorySnapshot(snapshot).rows.length,0);assert.equal(page.url(),sourceUrl);assert.equal(calls.length,4);
  assert.ok(calls.every(call=>/^https:\/\/internshala\.com\/api\/candidate\/dashboard\/paginated_applications\/(new|old)\/1\?dashboard_source=recent$/.test(call.url)));
  for(const call of calls){assert.deepEqual(call.options.multipart,{is_node_request:'1'});assert.deepEqual(call.options.headers,{'X-Auth-Token-Is':'1','X-FRONTEND-REQUEST':'1'});}
  let aborted=0,continued=0;
  const route=(url,body='is_node_request=1')=>({request:()=>({url:()=>url,method:()=> 'POST',postDataBuffer:()=>Buffer.from(body),allHeaders:async()=>({'content-type':'application/x-www-form-urlencoded'})}),abort:async()=>{aborted++;},continue:async()=>{continued++;}});
  await routes[0](route('https://internshala.com/application/submit/example'));
  await routes[0](route(calls[0].url,'is_node_request=1&extra=1'));
  await routes[0](route(calls[0].url));
  assert.equal(aborted,2);assert.equal(continued,1);
});
