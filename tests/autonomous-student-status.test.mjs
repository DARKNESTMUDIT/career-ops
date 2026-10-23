import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assess,hash,permitsStatedStudentStatus,validStudentStatus} from '../autonomous/policy.mjs';
import {studentStatusDisclosure,availabilityDisclosure} from '../autonomous/availability.mjs';
import {emailDraft} from '../autonomous/gmail.mjs';
import {verifyBundle,tailoredResume} from '../autonomous/bundle.mjs';
import {Ledger} from '../autonomous/ledger.mjs';
import {loadContext,run} from '../autonomous/runner.mjs';

const marker='<!-- career-ops:apply-with-stated-student-status=true -->';
const status='Second-year B.Com (Hons) student at Synthetic College, Synthetic University';
const jd='Synthetic Employer seeks a Product Intern. Fully remote work from India is available. Paid substantive product research, strategy and consulting with supervision. Apply by emailing jobs@employer.com.';
const tracks={remote:{earliest_start:'immediate',latest_end:'2099-06-30',max_months:6,max_hours_per_week:40,workplace:'fully remote from India'},summer:{earliest_start:'2099-07-01',latest_end:'2099-08-31',max_months:2,max_hours_per_week:40,workplace:'on-site India or remote'}};
const policy={tracks,applyWithStatedAvailability:true,applyWithStatedStudentStatus:true,studentStatus:status,minimumFit:4,unpaidFit:4.5};
function job(extra={}) {
  const value={company:'Synthetic Employer',role:'Product Intern',track:'remote',start:null,end:null,deadline:null,hours:null,remote:true,indiaEligible:true,studentEligible:null,country:'India',duties:'substantive',pay:'paid',fit:4.5,active:true,jd,evidence:{}};
  for(const key of Object.keys(value))if(key!=='evidence')value.evidence[key]=jd;
  value.evidence.studentEligible=null;
  return {...value,...extra};
}
function fixture(t,enabled=true,disclosure=status) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'student-status-'));
  const saved=Object.fromEntries(['CAREER_OPS_ROOT','CAREER_OPS_DATA_DIR','CAREER_OPS_TRACKER'].map(key=>[key,process.env[key]]));
  process.env.CAREER_OPS_ROOT=root;delete process.env.CAREER_OPS_DATA_DIR;process.env.CAREER_OPS_TRACKER=path.join(root,'data/applications.md');
  for(const dir of ['config','modes','data'])fs.mkdirSync(path.join(root,dir));
  fs.writeFileSync(path.join(root,'cv.md'),'# Synthetic Candidate\n\n## Education\n'+status+'\n\n## Experience\n- Product research experiments\n');
  fs.writeFileSync(path.join(root,'config/profile.yml'),JSON.stringify({candidate:{full_name:'Synthetic Candidate',email:'candidate@employer.com'},availability:tracks,application_disclosures:{student_status:disclosure}}));
  fs.writeFileSync(path.join(root,'modes/_profile.md'),'Synthetic approved targeting');
  fs.writeFileSync(path.join(root,'modes/_custom.md'),`<!-- career-ops:apply-with-stated-availability=true -->\n${enabled?marker:''}`);
  const ledger=new Ledger(root);
  t.after(()=>{ledger.close();for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(root,{recursive:true,force:true});});
  return {root,ledger,context:loadContext(root)};
}

test('trusted policy accepts omitted student eligibility and leaves employer eligibility null',()=>{
  const candidate=job();assert.equal(assess(candidate,policy).state,'eligible');
  assert.equal(permitsStatedStudentStatus(candidate,policy),true);assert.equal(candidate.studentEligible,null);
  for(const override of [{applyWithStatedStudentStatus:false},{applyWithStatedStudentStatus:undefined},{studentStatus:null},{studentStatus:'Student at college'}])assert.equal(assess(candidate,{...policy,...override}).state,'exception');
  assert.equal(assess(job({studentEligible:undefined}),policy).state,'exception');
});

test('explicit false, India eligibility and the other hard gates remain unchanged',()=>{
  for(const change of [{studentEligible:false},{indiaEligible:false},{indiaEligible:null},{remote:false},{duties:'excluded'},{fit:3.5}])assert.notEqual(assess(job(change),policy).state,'eligible');
});

test('graduate-only, final-year, discipline and degree restrictions cannot be laundered through null',()=>{
  for(const restriction of ['Graduates only.','Only graduates may apply.','Final-year students only.','Only third-year applicants.','First-year students welcome.','B.Tech / CSE required.','Computer Science students only.','Students pursuing engineering are eligible.','A bachelor degree is required.','MBA candidates only.','Masters degree students eligible.','Post-graduation is required.','Other open roles: CSE only.','Related jobs: Final-year students only.']) {
    const candidate=job({jd:jd+' '+restriction});
    assert.equal(permitsStatedStudentStatus(candidate,policy),false,restriction);
    assert.notEqual(assess(candidate,policy).state,'eligible',restriction);
  }
});

test('explicitly unrestricted degree language can coexist with unknown eligibility',()=>{
  for(const phrase of ['Any degree.','Any discipline may apply.','No degree required.','Degree is not required.','Work with engineering teams.'])assert.equal(assess(job({jd:jd+' '+phrase}),policy).state,'eligible',phrase);
});

test('disclosure requires a primary degree and year with no control characters',()=>{
  assert.equal(validStudentStatus(status),true);
  assert.equal(validStudentStatus('Third-year Bachelor of Science student at Example University'),true);
  for(const invalid of [null,'','Student at Example College','Second-year student at college',status+'\nInjected'])assert.equal(validStudentStatus(invalid),false);
});

test('only custom marker enables student policy and binds primary status into fingerprints',t=>{
  const f=fixture(t,false),before=f.context;
  assert.equal(before.policy.applyWithStatedStudentStatus,false);
  fs.appendFileSync(path.join(f.root,'cv.md'),`\n${marker}`);assert.equal(loadContext(f.root).policy.applyWithStatedStudentStatus,false);
  fs.appendFileSync(path.join(f.root,'modes/_custom.md'),`\n${marker}`);
  const after=loadContext(f.root);assert.equal(after.policy.studentStatus,status);
  assert.equal(after.policy.applyWithStatedStudentStatus,true);assert.notEqual(before.fingerprints.policy,after.fingerprints.policy);
});

test('email and PDF render exact primary degree/year and explain employer eligibility is unknown',t=>{
  const f=fixture(t),candidate={...job(),sourceUrl:'https://employer.com/product',fingerprints:{posting:hash(jd)}};
  const channel={verified:true,roleUrl:candidate.sourceUrl,sourceUrl:candidate.sourceUrl,employerHost:'employer.com',company:candidate.company,role:candidate.role,recipient:'jobs@employer.com',quote:'Apply by emailing jobs@employer.com.',postingHash:hash(jd)};
  const disclosure=studentStatusDisclosure(f.context,candidate);
  assert.ok(disclosure.includes(status));assert.ok(disclosure.includes('does not confirm eligibility for my degree and year'));
  assert.ok(emailDraft(f.context,candidate,channel).body.includes(disclosure));
  assert.ok(tailoredResume(f.context,candidate).html.includes(disclosure));
  assert.ok(availabilityDisclosure({...f.context,policy:{...f.context.policy,applyWithStatedAvailability:false}},candidate).includes(disclosure));
  assert.equal(candidate.studentEligible,null);
  assert.throws(()=>studentStatusDisclosure({...f.context,profile:{...f.context.profile,application_disclosures:{student_status:'Changed'}}},candidate),/missing or changed/);
});

test('form uploads an actual generated PDF containing the degree/year disclosure while decision stays null',async t=>{
  const f=fixture(t),id=f.ledger.add('https://employer.com/product');let prompt='';
  const result=await run({root:f.root,maxEvaluations:1,fetchJD:async()=>({text:jd}),evaluate:async text=>{prompt=text;return job();},prepare:async({resumePath,bundle})=>{
    const pdf=fs.readFileSync(resumePath);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>500);
    const html=fs.readFileSync(path.join(bundle,'resume.html'),'utf8');assert.ok(html.includes(`My current student status: ${status}.`));
    const resumeHash=hash(pdf.toString('base64'));return {complete:true,issues:[],resumeHash,answers:[{type:'file',fileHash:resumeHash}]};
  }});
  assert.equal(result.complete,1,JSON.stringify(f.ledger.job(id).payload.reasons));
  assert.ok(prompt.includes('keep studentEligible null: never set it true from absence'));
  const ready=f.ledger.job(id);assert.equal(ready.payload.studentEligible,null);assert.ok(verifyBundle(ready.payload.bundle,ready.payload.fingerprints));
  assert.equal(JSON.parse(fs.readFileSync(path.join(ready.payload.bundle,'decision.json'),'utf8')).studentEligible,null);
});

test('missing primary disclosure prevents form preparation rather than inventing degree/year',async t=>{
  const f=fixture(t,true,null);f.ledger.add('https://employer.com/product');let preparations=0;
  const result=await run({root:f.root,maxEvaluations:1,fetchJD:async()=>({text:jd}),evaluate:async()=>job(),prepare:async()=>{preparations++;throw new Error('must not prepare');}});
  assert.ok(result.complete===0);assert.equal(preparations,0);
});

test('student omission exception requires exact source proof this is an internship',()=>{
  const fullTime=jd.replace('Product Intern','Product Analyst')+' This is a permanent role.';
  const candidate=job({role:'Product Analyst',jd:fullTime,evidence:{...job().evidence,role:fullTime}});
  assert.equal(permitsStatedStudentStatus(candidate,policy),false);
  assert.notEqual(assess(candidate,policy).state,'eligible');
  assert.equal(permitsStatedStudentStatus(job({evidence:{...job().evidence,role:'Internship invented outside source'}}),policy),false);
});
