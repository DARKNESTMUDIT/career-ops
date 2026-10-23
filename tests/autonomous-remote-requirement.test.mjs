import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assess,permitsStatedRemoteRequirement,hash} from '../autonomous/policy.mjs';
import {availabilityDisclosure} from '../autonomous/availability.mjs';
import {verifyBundle,tailoredResume} from '../autonomous/bundle.mjs';
import {emailDraft} from '../autonomous/gmail.mjs';
import {Ledger} from '../autonomous/ledger.mjs';
import {run,loadContext} from '../autonomous/runner.mjs';

const marker='<!-- career-ops:apply-with-stated-remote-requirement=true -->';
const jd='Synthetic Employer seeks a Product Intern. Remote-friendly. Current students in India are eligible. Paid substantive product research and consulting projects with supervision. Apply by emailing jobs@employer.com.';
const tracks={remote:{earliest_start:'immediate',latest_end:'2099-06-30',max_months:6,max_hours_per_week:40,workplace:'fully remote from India'},summer:{earliest_start:'2099-07-01',latest_end:'2099-08-31',max_months:2,max_hours_per_week:40,workplace:'on-site India or remote'}};
const policy={tracks,applyWithStatedAvailability:true,applyWithStatedRemoteRequirement:true,minimumFit:4,unpaidFit:4.5};
function job(extra={}) {
  const value={company:'Synthetic Employer',role:'Product Intern',track:'remote',start:null,end:null,deadline:null,hours:null,remote:null,indiaEligible:true,studentEligible:true,country:'India',duties:'substantive',pay:'paid',fit:4.5,active:true,jd,evidence:{}};
  for(const key of Object.keys(value))if(key!=='evidence')value.evidence[key]=jd;
  value.evidence.remote='Remote-friendly';
  return {...value,...extra};
}
function fixture(t,enabled=true) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'remote-requirement-'));
  const saved=Object.fromEntries(['CAREER_OPS_ROOT','CAREER_OPS_DATA_DIR','CAREER_OPS_TRACKER'].map(key=>[key,process.env[key]]));
  process.env.CAREER_OPS_ROOT=root;delete process.env.CAREER_OPS_DATA_DIR;process.env.CAREER_OPS_TRACKER=path.join(root,'data/applications.md');
  for(const dir of ['config','modes','data'])fs.mkdirSync(path.join(root,dir));
  fs.writeFileSync(path.join(root,'cv.md'),'# Synthetic Candidate\n\n## Experience\n- Product research experiments\n');
  fs.writeFileSync(path.join(root,'config/profile.yml'),JSON.stringify({candidate:{full_name:'Synthetic Candidate',email:'candidate@employer.com'},availability:tracks}));
  fs.writeFileSync(path.join(root,'modes/_profile.md'),'Synthetic approved targeting');
  fs.writeFileSync(path.join(root,'modes/_custom.md'),`<!-- career-ops:apply-with-stated-availability=true -->\n${enabled?marker:''}`);
  const ledger=new Ledger(root);
  t.after(()=>{ledger.close();for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(root,{recursive:true,force:true});});
  return {root,ledger,context:loadContext(root)};
}
const requirement='I require a fully remote arrangement from India.';

test('trusted policy permits exact remote-friendly evidence without changing unknown employer remote',()=>{
  const candidate=job();assert.equal(permitsStatedRemoteRequirement(candidate,policy),true);
  assert.equal(assess(candidate,policy).state,'eligible');assert.equal(candidate.remote,null);
  assert.equal(assess(candidate,{...policy,applyWithStatedRemoteRequirement:false}).state,'exception');
  assert.equal(assess(candidate,{...policy,applyWithStatedRemoteRequirement:undefined}).state,'exception');
  assert.equal(assess(job({track:'summer'}),policy).state,'exception');
});

test('missing source proof, explicit false and on-site/hybrid conflicts cannot use the exception',()=>{
  for(const candidate of [
    job({remote:false}),job({remote:undefined}),
    job({evidence:{...job().evidence,remote:'Remote-friendly but nonexistent quote'}}),
    job({evidence:{...job().evidence,remote:'Paid substantive product research'}}),
    job({jd:jd+' Location: Hybrid.'}),job({jd:jd+' This is a hybrid role.'}),job({jd:jd+' Hybrid.'}),job({jd:jd+' You must work on-site three days a week.'}),
    job({jd:jd+' On-site attendance is required.'}),job({jd:jd+' Fully remote work is not supported.'}),
    job({jd:jd.replace('Remote-friendly','Not remote-friendly'),evidence:{...job().evidence,remote:'Not remote-friendly'}}),
    job({evidence:{...job().evidence,remote:'Remote-friendly; hybrid'}}),
  ])assert.notEqual(assess(candidate,policy).state,'eligible',JSON.stringify(candidate));
  const invented=assess(job({remote:true}),policy);assert.equal(invented.state,'exception');
  assert.ok(invented.reasons.some(reason=>reason.includes('keep employer remote unknown')));
});

test('India and student eligibility remain explicit independent hard gates',()=>{
  for(const extra of [{indiaEligible:false},{indiaEligible:null},{studentEligible:false},{studentEligible:null},{indiaEligible:'true'},{studentEligible:'true'}])assert.notEqual(assess(job(extra),policy).state,'eligible');
});

test('untrusted footer labels cannot conceal a later workplace contradiction',()=>{
  for(const tail of ['Other open roles: Hybrid Engineer, mandatory on-site attendance.','Other open roles: This is a hybrid role.','Related jobs: In-office work is required.']) {
    assert.notEqual(assess(job({jd:jd+' '+tail}),policy).state,'eligible');
    assert.equal(permitsStatedRemoteRequirement(job({jd:jd+' '+tail}),policy),false);
  }
});

test('only trusted custom marker enables the policy and changes source fingerprints',t=>{
  const f=fixture(t,false),before=loadContext(f.root);
  assert.equal(before.policy.applyWithStatedRemoteRequirement,false);
  fs.appendFileSync(path.join(f.root,'cv.md'),`\n${marker}`);
  assert.equal(loadContext(f.root).policy.applyWithStatedRemoteRequirement,false);
  fs.appendFileSync(path.join(f.root,'modes/_custom.md'),`\n${marker}`);
  const after=loadContext(f.root);
  assert.equal(after.policy.applyWithStatedRemoteRequirement,true);
  assert.notEqual(before.fingerprints.policy,after.fingerprints.policy);
  assert.notEqual(before.fingerprints.procedure,after.fingerprints.procedure);
});

test('outgoing email explicitly states the candidate remote India requirement while employer facts remain unknown',t=>{
  const f=fixture(t),candidate={...job(),sourceUrl:'https://employer.com/jobs/product',fingerprints:{posting:hash(jd)}};
  const channel={verified:true,roleUrl:candidate.sourceUrl,sourceUrl:candidate.sourceUrl,employerHost:'employer.com',company:candidate.company,role:candidate.role,recipient:'jobs@employer.com',quote:'Apply by emailing jobs@employer.com.',postingHash:hash(jd)};
  const draft=emailDraft(f.context,candidate,channel);
  assert.ok(draft.body.includes(requirement));assert.ok(draft.body.includes('not employer-confirmed'));
  assert.ok(draft.body.includes('Please confirm this requirement can be accommodated.'));
  assert.equal(candidate.remote,null);
  assert.ok(availabilityDisclosure({...f.context,policy:{...f.context.policy,applyWithStatedAvailability:false}},candidate).includes(requirement));
});

test('actual generated PDF uses rendered remote requirement and form bundle seals that attachment',async t=>{
  const f=fixture(t),id=f.ledger.add('https://employer.com/jobs/product');
  let prompt='',preparedPDF;
  const result=await run({root:f.root,maxEvaluations:1,fetchJD:async()=>({text:jd}),evaluate:async text=>{prompt=text;return job();},prepare:async({resumePath,bundle})=>{
    preparedPDF=fs.readFileSync(resumePath);assert.equal(preparedPDF.subarray(0,5).toString(),'%PDF-');assert.ok(preparedPDF.length>500);
    assert.ok(fs.readFileSync(path.join(bundle,'resume.html'),'utf8').includes(requirement));
    const resumeHash=hash(preparedPDF.toString('base64'));
    return {complete:true,issues:[],resumeHash,answers:[{type:'file',fileHash:resumeHash}]};
  }});
  assert.equal(result.complete,1,JSON.stringify(f.ledger.job(id).payload.reasons));
  assert.ok(prompt.includes('select track remote while keeping remote null'));
  assert.ok(prompt.includes('do not set remote true'));
  const ready=f.ledger.job(id);assert.equal(ready.state,'ready');assert.equal(ready.payload.remote,null);
  assert.ok(verifyBundle(ready.payload.bundle,ready.payload.fingerprints));
  const decision=JSON.parse(fs.readFileSync(path.join(ready.payload.bundle,'decision.json'),'utf8'));
  assert.equal(decision.remote,null);assert.ok(preparedPDF.length>500);
  const claims=JSON.parse(fs.readFileSync(path.join(ready.payload.bundle,'claims.json'),'utf8'));
  assert.ok(claims.every(claim=>claim.source==='cv.md'));assert.ok(!claims.some(claim=>claim.text.includes(requirement)));
});

test('ordinary known-remote resumes do not gain an unneeded conditional requirement section',t=>{
  const f=fixture(t);
  assert.ok(!tailoredResume(f.context,job({remote:true})).html.includes(requirement));
  assert.ok(!tailoredResume({...f.context,policy:{...f.context.policy,applyWithStatedRemoteRequirement:false}},job()).html.includes(requirement));
});
