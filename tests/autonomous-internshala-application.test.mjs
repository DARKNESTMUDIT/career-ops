import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Ledger} from '../autonomous/ledger.mjs';
import {validateInternshalaApplicationAnswers,validateInternshalaPlatformResumeReview,verifyInternshalaHistoryBinding,verifyInternshalaApplicationReceipt,verifyInternshalaRejectedReceipt,internshalaRejectionSnapshot,reconcileInternshalaApplication,compareInternshalaCandidatePreparation,prepareInternshalaApplication,observeInternshalaApplication,submitInternshalaPrepared} from '../autonomous/internshala-application.mjs';
import {ARH_NATIVE_SLUG} from '../autonomous/internshala-transport.mjs';
import {internshalaHistoryDigest} from '../autonomous/internshala-history.mjs';
import {intentDigest} from '../autonomous/internshala-receipts.mjs';
import {reconcileApplicationForm} from '../autonomous-runner.mjs';
import {resolveIntegrityPause} from '../autonomous/recovery.mjs';
import {integrityPause} from '../autonomous/rollout.mjs';
import {chromium} from 'playwright';
const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture() {
  const sources={'cv.md':'Synthetic primary CV.','config/profile.yml':'earliest_start: immediate\nworkplace: fully remote from India','modes/_profile.md':'Synthetic targeting.'};
  const context={sources,profile:{availability:{remote:{earliest_start:'immediate',workplace:'fully remote from India'},summer:{earliest_start:'2027-06-01',latest_end:'2027-07-31'}}}};
  const answers={reviewed:true,fields:{confirm_availability:{value:'yes',source:'config/profile.yml',sourceSha256:sha(sources['config/profile.yml']),quote:'earliest_start: immediate'}}};
  return {context,answers,job:{track:'remote'}};
}
test('reviewed immediate availability uses current primary configuration only',()=>{
  const input=fixture(),result=validateInternshalaApplicationAnswers(input);
  assert.equal(result.sourceProofs['config/profile.yml'].sha256,input.answers.fields.confirm_availability.sourceSha256);
  assert.deepEqual(result.approvedSources,['cv.md','config/profile.yml','modes/_profile.md']);
});
test('derived, stale, unreviewed and invented primary answers are rejected',()=>{
  for(const change of [i=>i.answers.reviewed=false,i=>i.answers.fields.confirm_availability.source='HANDOFF.md',i=>i.answers.fields.confirm_availability.source='modes/_custom.md',i=>i.answers.fields.confirm_availability.sourceSha256=sha('old primary'),i=>i.answers.fields.confirm_availability.quote='invented immediate availability',i=>i.context.profile.availability.remote.earliest_start='2027-06-01',i=>i.context.profile.availability.remote.workplace='on-site']) {
    const input=fixture();change(input);assert.throws(()=>validateInternshalaApplicationAnswers(input));
  }
});
test('no availability explanation is guessed or rewritten from a claimed source',()=>{
  const input=fixture();input.answers.fields.confirm_availability.value='no';
  input.answers.fields.confirm_availability_textarea={value:'Invented longer commitment',source:'cv.md',sourceSha256:sha(input.context.sources['cv.md']),quote:'Synthetic primary CV.'};
  assert.throws(()=>validateInternshalaApplicationAnswers(input),/primary-backed/);
});
test('summer limits cannot drift from June 1 through July 31 2027',()=>{
  const input=fixture();input.job.track='summer';input.answers.fields.confirm_availability.value='no';
  input.context.profile.availability.summer.latest_end='2027-08-01';
  assert.throws(()=>validateInternshalaApplicationAnswers(input),/Summer availability/);
});
function lockedLedger(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'internshala-wrapper-synthetic-'));
  const ledger=new Ledger(root),token=ledger.acquire();
  t.after(()=>{ledger.release(token);ledger.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,ledger};
}
test('fixture cannot register or bypass actual live adapter certification',async t=>{
  const {root,ledger}=lockedLedger(t),id=ledger.add(`https://internshala.com/internship/detail/${ARH_NATIVE_SLUG}`);
  let touched=0;
  const page=new Proxy({},{get(){touched++;throw Error('Browser must not be touched');}});
  await assert.rejects(submitInternshalaPrepared(page,{root,ledger,id,context:{fingerprints:{}},prepared:{complete:true},historySnapshot:()=>{throw Error('History must not be touched');}}));
  assert.equal(touched,0);assert.equal(ledger.status().attempts.length,0);assert.equal(ledger.job(id).state,'discovered');
});
test('observation refuses other roles before navigation or native interaction',async t=>{
  const {ledger}=lockedLedger(t),id=ledger.add('https://internshala.com/internship/detail/other-internship');
  await assert.rejects(observeInternshalaApplication({}, {ledger,id,directory:ledger.dir}),/Only exact observed native/);
  assert.equal(ledger.status().attempts.length,0);
});
test('preparation requires actual page-bound script/form observation and never fills first',async t=>{
  const {ledger}=lockedLedger(t),url=`https://internshala.com/internship/detail/${ARH_NATIVE_SLUG}`,id=ledger.add(url);
  ledger.update(id,'eligible',{sourceUrl:url,role:'General Management',company:'Synthetic employer'});
  const input=fixture();
  await assert.rejects(prepareInternshalaApplication({}, {ledger,id,...input,bundle:ledger.dir}),/Page-bound original native observation required/);
  assert.equal(ledger.status().attempts.length,0);assert.equal(ledger.job(id).state,'eligible');
});

test('built-in platform resume review binds actual protected text and every current primary',()=>{
  const {context}=fixture(),observedSha256=sha('SYNTHETIC current platform resume; not candidate evidence');
  const review={version:1,reviewed:true,conformsToPrimary:true,discrepancies:[],observedSha256,sourceProofs:Object.fromEntries(['cv.md','config/profile.yml','modes/_profile.md'].map(source=>[source,{sha256:sha(context.sources[source])}]))};
  assert.equal(validateInternshalaPlatformResumeReview({review,observedSha256,context}),true);
  for(const change of [r=>r.reviewed=false,r=>r.conformsToPrimary=false,r=>r.discrepancies=['Stale GPA'],r=>r.observedSha256=sha('old platform resume'),r=>r.sourceProofs['cv.md'].sha256=sha('old CV')]) {
    const changed=structuredClone(review);change(changed);
    assert.throws(()=>validateInternshalaPlatformResumeReview({review:changed,observedSha256,context}));
  }
});
test('recovery cannot create receipt or tracker credit from a job without native intent',t=>{
  const {ledger}=lockedLedger(t),url=`https://internshala.com/internship/detail/${ARH_NATIVE_SLUG}`,id=ledger.add(url);
  ledger.update(id,'eligible',{sourceUrl:url,role:'General Management',company:'Synthetic employer'});
  assert.throws(()=>verifyInternshalaApplicationReceipt({ledger,id}),/Durable native attempt required/);
  assert.equal(ledger.job(id).state,'eligible');assert.equal(ledger.status().attempts.length,0);
});

function baselineFixture(ledger) {
  const directory=path.join(ledger.dir,'synthetic-history');fs.mkdirSync(directory,{mode:0o700});
  const save=(name,bytes)=>{const file=path.join(directory,name);fs.writeFileSync(file,bytes,{mode:0o600});return {path:file,sha256:sha(bytes)};};
  const sourceUrl=`https://internshala.com/internship/detail/${ARH_NATIVE_SLUG}`;
  const start='2026-10-31T00:00:00.000Z',end='2026-10-31T00:00:10.000Z';
  const raw=Buffer.from(JSON.stringify({success:true,applications:[],recent_application_count:'0',old_application_count:'0'}));
  const responses=['page','stability'].flatMap((purpose,index)=>['new','old'].map(type=>({type,page:1,purpose,url:`https://internshala.com/api/candidate/dashboard/paginated_applications/${type}/1?dashboard_source=recent`,status:200,observedAt:`2026-10-31T00:00:0${index+1}.000Z`,bodyBase64:raw.toString('base64'),bodySha256:sha(raw),artifact:save(`${type}-${purpose}.json`,raw)})));
  const html='<html><body>Synthetic empty history, no real application credit.</body></html>';
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR5kAAAAASUVORK5CYII=','base64');
  const before={version:'next-history@1',phase:'before',sourceUrl,startedAt:start,completedAt:end,responses,ui:{pageUrl:'https://internshala.com/student/applications/?dashboard_source=recent',observedAt:'2026-10-31T00:00:03.000Z',pageHtml:html,pageSha256:sha(html),pageArtifact:save('ui.html',Buffer.from(html)),screenshotBase64:png.toString('base64'),screenshotSha256:sha(png),screenshotArtifact:save('ui.png',png),card:null}};
  const artifact=save('immutable-before.json',Buffer.from(JSON.stringify(before,null,2)));
  const intent={sourceUrl,company:'Synthetic employer',role:'General Management',historyBeforeSha256:internshalaHistoryDigest(before),historyBeforeArtifact:artifact};
  const id=ledger.add(sourceUrl);ledger.update(id,'eligible',{sourceUrl,company:intent.company,role:intent.role,internshalaHistoryBefore:artifact,internshalaHistoryBeforeSha256:intent.historyBeforeSha256});
  return {id,intent,before,artifact};
}
test('baseline binds original provider source, complete raw proof digest and immutable bytes without application credit',t=>{
  const {ledger}=lockedLedger(t),input=baselineFixture(ledger);
  const result=verifyInternshalaHistoryBinding({ledger,...input});
  assert.equal(result.historyBeforeSha256,input.intent.historyBeforeSha256);
  assert.equal(ledger.status().attempts.length,0);assert.equal(ledger.job(input.id).state,'eligible');
  const other=structuredClone(input.before);other.completedAt='2026-10-31T00:00:11.000Z';
  assert.throws(()=>verifyInternshalaHistoryBinding({ledger,...input,history:{version:'next-history@1',before:other}}),/Receipt history baseline differs/);
  fs.appendFileSync(input.artifact.path,' ');
  assert.throws(()=>verifyInternshalaHistoryBinding({ledger,...input}),/Immutable provider history baseline changed/);
});
test('baseline recovery detects independent raw proof corruption and ledger hash replacement',t=>{
  const {ledger}=lockedLedger(t),input=baselineFixture(ledger);
  const raw=input.before.responses[0].artifact;
  fs.appendFileSync(raw.path,' ');
  assert.throws(()=>verifyInternshalaHistoryBinding({ledger,...input}),/raw artifact changed/);
  ledger.update(input.id,'eligible',{internshalaHistoryBeforeSha256:sha('forged baseline')});
  assert.throws(()=>verifyInternshalaHistoryBinding({ledger,...input}),/binding mismatch/);
  assert.equal(ledger.status().attempts.length,0);
});

test('fresh native protocol resealing preserves every reviewed candidate answer and exact PDF',()=>{
  const candidate={provider:'internshala',complete:true,issues:[],answers:[{ref:'custom_resume',type:'file',fileHash:'synthetic-pdf'}],resumeHash:'synthetic-pdf',plan:{sourceUrl:'synthetic-source',jobId:'exact-role',jobIdField:'internshipId',fields:{confirm_availability:{value:'no',source:'cv.md'}},sourceProofs:{'cv.md':{sha256:sha('primary')}},approvedSources:['cv.md'],pdf:{sha256:sha('synthetic-pdf')},nativeForm:{formArtifact:{path:'/synthetic/old-form'}},protocolFields:{csrf_test_name:{value:'synthetic-old-token'}},platformResumeReview:{path:'/synthetic/review',sha256:sha('review')}}};
  const current=structuredClone(candidate);current.plan.nativeForm.formArtifact.path='/synthetic/new-form';current.plan.protocolFields.csrf_test_name.value='synthetic-new-token';
  assert.equal(compareInternshalaCandidatePreparation(candidate,current),true);
  for(const change of [p=>p.plan.fields.confirm_availability.value='yes',p=>p.plan.pdf.sha256=sha('different PDF'),p=>p.plan.sourceProofs['cv.md'].sha256=sha('different primary'),p=>p.plan.platformResumeReview.sha256=sha('different review')]) {
    const changed=structuredClone(current);change(changed);assert.throws(()=>compareInternshalaCandidatePreparation(candidate,changed));
  }
});
function nativeAttemptFixture(t,{body='{"success":false}',status=200,omitResponse=false}={}) {
  const {root,ledger}=lockedLedger(t),baseline=baselineFixture(ledger),{id}=baseline,attempt='synthetic-native-attempt';
  const directory=path.join(ledger.dir,'synthetic-original-capture');fs.mkdirSync(directory,{mode:0o700});
  const save=(name,value)=>{const bytes=Buffer.from(JSON.stringify(value,null,2)),file=path.join(directory,name);fs.writeFileSync(file,bytes,{mode:0o600});return {path:file,sha256:sha(bytes)};};
  const pdf=Buffer.from('%PDF-1.4 SYNTHETIC ONLY'),source='cv.md',sourceSha256=sha('synthetic-primary');
  const intent={...baseline.intent,state:'active',durableReference:attempt,reservedBeforeFirstPII:true,answersReviewed:true,jobId:ARH_NATIVE_SLUG,jobIdField:'internshipId',approvedSources:[source],sourceProofs:{[source]:{sha256:sourceSha256}},fields:{confirm_availability:{value:'no',source,sourceSha256}},pdf:{fieldName:'custom_resume',filename:'synthetic.pdf',size:pdf.length,sha256:sha(pdf),frozenBeforeIntent:true}};
  const sealedIntentSha256=intentDigest(intent),intentFile=save('intent.json',intent).path;
  ledger.db.prepare('INSERT INTO attempts VALUES (?,?,?,?,NULL)').run(attempt,id,'2026-10-31','intent');
  ledger.event(id,'submission-intent',{attempt,fingerprints:{cv:sourceSha256}});
  ledger.update(id,'uncertain',{fingerprints:{cv:sourceSha256},internshalaIntentFile:intentFile,internshalaIntentSha256:sealedIntentSha256,internshalaProofDir:directory,noRetry:true});
  const captureIntent=save('capture-intent.json',{intent,sealedIntentSha256,attempt,ledgerJobId:id});ledger.event(id,'internshala-capture-started',{attempt,seal:captureIntent.sha256});
  const boundary='synthetic-recovery-boundary',parts=[];
  for(const [name,value] of [['internshipId',ARH_NATIVE_SLUG],['confirm_availability','no']])parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="custom_resume"; filename="synthetic.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),pdf,Buffer.from(`\r\n--${boundary}--\r\n`));
  const wire=Buffer.concat(parts),request={startedDateTime:'2026-10-31T00:00:20.000Z',request:{method:'POST',url:`https://internshala.com/application/submit/${ARH_NATIVE_SLUG}`,postData:{mimeType:`multipart/form-data; boundary=${boundary}`,bodyBase64:wire.toString('base64'),bodySha256:sha(wire)}},response:{}};
  const requestProof=save('request.json',request);ledger.event(id,'internshala-native-request-observed',{attempt,requestHash:requestProof.sha256});
  let response={};
  if(!omitResponse) {response={status,url:request.request.url,observedAt:'2026-10-31T00:00:21.000Z',content:{text:Buffer.from(body).toString('base64'),encoding:'base64'},bodySha256:sha(body)};const proof=save('response.json',response);ledger.event(id,'internshala-native-response-observed',{attempt,responseHash:proof.sha256});}
  save('capture.json',{attempt,continued:true,failures:[],har:{log:{entries:[{...request,response}]}}});
  return {root,ledger,id,directory};
}
test('generic HAR intents cannot gain native receipt or rejection credit regardless of response body',async t=>{
  for(const options of [{body:'{"success":false}'},{body:'{"success":true}'},{omitResponse:true},{body:'{"unrecognized":true}'},{body:'not JSON'},{body:'{"error":"Unknown failure"}',status:500}]) {
    const input=nativeAttemptFixture(t,options);let reads=0;
    const before=fs.readFileSync(path.join(input.directory,'request.json'));
    await assert.rejects(reconcileInternshalaApplication({...input,historySnapshot:()=>{reads++;throw Error('Incomplete native proof must not read history');}}),/Complete original native form and script proof required/);
    assert.equal(reads,0);assert.equal(input.ledger.job(input.id).state,'uncertain');assert.equal(input.ledger.status().attempts[0].outcome,'intent');
    assert.deepEqual(fs.readFileSync(path.join(input.directory,'request.json')),before);
    assert.equal(fs.readdirSync(input.directory).some(name=>name.startsWith('reconciliation-')),false);
  }
});
test('independent AFTER history artifacts must retain their original bytes before receipt verification',t=>{
  const {ledger}=lockedLedger(t),input=baselineFixture(ledger),after=structuredClone(input.before);
  after.phase='after';after.startedAt='2026-10-31T00:00:30.000Z';after.completedAt='2026-10-31T00:00:40.000Z';
  for(const proof of after.responses)proof.observedAt=proof.purpose==='page'?'2026-10-31T00:00:31.000Z':'2026-10-31T00:00:32.000Z';
  after.ui.observedAt='2026-10-31T00:00:33.000Z';
  const file=path.join(ledger.dir,'independent-after-ui.html');fs.writeFileSync(file,after.ui.pageHtml,{mode:0o600});after.ui.pageArtifact={path:file,sha256:sha(after.ui.pageHtml)};
  const history={version:'next-history@1',before:input.before,after};
  assert.equal(verifyInternshalaHistoryBinding({ledger,...input,history}).historyBeforeSha256,input.intent.historyBeforeSha256);
  fs.appendFileSync(file,' changed');
  assert.throws(()=>verifyInternshalaHistoryBinding({ledger,...input,history}),/receipt raw artifact changed/);
  assert.equal(ledger.status().attempts.length,0);
});

const emptyTracker='# Synthetic tracker only\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n';
test('canonical confirmed dispatch cannot promote generic HAR proof or launch browser',async t=>{
  const input=nativeAttemptFixture(t,{body:'{"success":true}'});let launched=0;
  t.mock.method(chromium,'launchPersistentContext',()=>{launched++;throw Error('Incomplete stored proof must never open browser');});
  input.ledger.db.prepare("UPDATE attempts SET outcome='confirmed',receipt=? WHERE job_id=?").run(JSON.stringify({kind:'form-confirmation',provider:'internshala',reference:'SYNTHETIC-NO-CREDIT'}),input.id);
  input.ledger.update(input.id,'confirmed',{});
  await assert.rejects(reconcileApplicationForm(input),/Complete original native form and script proof required/);
  assert.equal(launched,0);assert.equal(input.ledger.job(input.id).state,'confirmed');assert.equal(input.ledger.job(input.id).payload.trackerSync,undefined);
});
test('guarded recovery refuses fabricated native rejection with missing mandatory original proof',async t=>{
  const input=nativeAttemptFixture(t);
  fs.writeFileSync(path.join(input.root,'data/applications.md'),emptyTracker);
  input.ledger.db.prepare("UPDATE attempts SET outcome='rejected',receipt=? WHERE job_id=?").run(JSON.stringify({kind:'form-rejected',provider:'internshala',reference:'SYNTHETIC-NO-CREDIT'}),input.id);
  input.ledger.update(input.id,'exception',{noRetry:true});integrityPause(input.ledger,'Synthetic missing original native proof');
  await assert.rejects(resolveIntegrityPause(input.root,input.ledger),/Complete original native form and script proof required/);
  assert.equal(input.ledger.get('paused'),true);assert.equal(input.ledger.job(input.id).state,'exception');assert.equal(input.ledger.job(input.id).payload.trackerSync,undefined);
});
test('unknown rejected receipt provider cannot fall through to another canonical verifier or clear integrity pause',async t=>{
  const input=nativeAttemptFixture(t);
  fs.writeFileSync(path.join(input.root,'data/applications.md'),emptyTracker);
  input.ledger.db.prepare("UPDATE attempts SET outcome='rejected',receipt=? WHERE job_id=?").run(JSON.stringify({kind:'form-rejected',provider:'unknown-provider',reference:'SYNTHETIC-NO-CREDIT'}),input.id);
  input.ledger.update(input.id,'exception',{noRetry:true});integrityPause(input.ledger,'Synthetic unknown rejected provider');
  await assert.rejects(resolveIntegrityPause(input.root,input.ledger),/Unsupported or mismatched rejected form provider/);
  assert.equal(input.ledger.get('paused'),true);assert.equal(input.ledger.job(input.id).state,'exception');
});
