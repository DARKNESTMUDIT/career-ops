import {test} from 'node:test';
import assert from 'node:assert/strict';
import {permitsStatedIndiaLocation,assess} from '../autonomous/policy.mjs';
import {indiaLocationDisclosure,availabilityDisclosure} from '../autonomous/availability.mjs';
import {tailoredResume} from '../autonomous/bundle.mjs';
import {emailDraft} from '../autonomous/gmail.mjs';
import {hash} from '../autonomous/policy.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadContext} from '../autonomous/runner.mjs';
const quote='Fully remote: work from wherever you do your best thinking.';
const jd=`Example seeks a Product Intern. ${quote} Paid substantive product research and strategy with mentorship and useful learning opportunities.`;
const policy={applyWithStatedIndiaLocation:true,candidateCountry:'India',applyWithStatedAvailability:true,minimumFit:4,unpaidFit:4.5,tracks:{remote:{earliest_start:'immediate',latest_end:'2099-06-30',max_months:6,max_hours_per_week:40,workplace:'fully remote from India'}}};
const job={company:'Example',role:'Product Intern',track:'remote',jd,active:true,remote:true,indiaEligible:null,studentEligible:true,start:null,end:null,deadline:null,hours:null,pay:'paid',duties:'substantive',fit:4.5,evidence:Object.fromEntries(['company','role','remote','studentEligible','pay','duties','fit'].map(k=>[k,k==='remote'?quote:jd]))};
test('trusted country omission permits null while leaving employer acceptance unknown',()=>{
  assert.equal(permitsStatedIndiaLocation(job,policy),true);assert.equal(assess(job,policy).state,'eligible');assert.equal(job.indiaEligible,null);
  for(const delta of [{applyWithStatedIndiaLocation:false},{candidateCountry:null}])assert.equal(assess(job,{...policy,...delta}).state,'exception');
  for(const delta of [{indiaEligible:false},{indiaEligible:undefined},{remote:false},{remote:null},{track:'summer'},{duties:'excluded'},{fit:3}])assert.notEqual(assess({...job,...delta},policy).state,'eligible');
});
test('country restrictions and workplace conflicts cannot be laundered through null',()=>{
  for(const phrase of ['US only.','UK-only applicants.','We hire exclusively in Canada.','Must be based in Europe.','Applicants must reside in the US.','Eligible countries: USA, Canada.','Locations supported: Germany.','Work authorization is required.','Right to work in the USA required.','We do not hire from India.','Not available to applicants in India.','Hybrid work required.','On-site attendance required.','US-based candidates welcome.','Remote except India.','Candidates outside Asia welcome.']){
    assert.equal(permitsStatedIndiaLocation({...job,jd:jd+' '+phrase},policy),false,phrase);
    assert.notEqual(assess({...job,jd:jd+' '+phrase},policy).state,'eligible',phrase);
  }
  assert.equal(permitsStatedIndiaLocation({...job,jd:jd+' Company headquarters: New York, USA.'},policy),true);
});
test('only trusted custom marker enables policy and binds primary country to policy fingerprint',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'india-policy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['config','modes','data'])fs.mkdirSync(path.join(root,dir));
  const marker='<!-- career-ops:apply-with-stated-india-location=true -->';
  fs.writeFileSync(path.join(root,'cv.md'),'# Example\n'+marker);fs.writeFileSync(path.join(root,'modes/_profile.md'),'Example targeting');fs.writeFileSync(path.join(root,'modes/_custom.md'),'');
  fs.writeFileSync(path.join(root,'config/profile.yml'),JSON.stringify({candidate:{location:'Example, India'},availability:{remote:policy.tracks.remote,summer:policy.tracks.remote}}));
  const before=loadContext(root);assert.equal(before.policy.applyWithStatedIndiaLocation,false);
  fs.writeFileSync(path.join(root,'modes/_custom.md'),marker);const after=loadContext(root);assert.equal(after.policy.applyWithStatedIndiaLocation,true);assert.equal(after.policy.candidateCountry,'India');assert.notEqual(before.fingerprints.policy,after.fingerprints.policy);
});
test('quoted remote evidence and matching primary location are mandatory',()=>{
  assert.equal(permitsStatedIndiaLocation({...job,evidence:{...job.evidence,remote:'invented remote quote'}},policy),false);
  const context={policy,profile:{candidate:{location:'Example city, India'},availability:policy.tracks}};
  const text=indiaLocationDisclosure(context,job);assert.match(text,/based in India/);assert.match(text,/does not confirm/);
  assert.ok(availabilityDisclosure(context,job).includes(text));
  assert.throws(()=>indiaLocationDisclosure({...context,profile:{candidate:{location:'Elsewhere'}}},job),/missing or changed/);
});
test('outgoing email and PDF both contain the location and unconfirmed acceptance disclosure',()=>{
  const context={policy,profile:{candidate:{location:'Example city, India',full_name:'Example Candidate',email:'candidate@example.org'},availability:policy.tracks},sources:{'cv.md':'# Example Candidate\n\nResearch and analysis experience.'}};
  const candidate={...job,sourceUrl:'https://example.org/careers',jd:jd+' Apply: jobs@example.org'};
  const channel={verified:true,company:candidate.company,role:candidate.role,roleUrl:candidate.sourceUrl,sourceUrl:candidate.sourceUrl,employerHost:'example.org',recipient:'jobs@example.org',quote:'Apply: jobs@example.org',postingHash:hash(candidate.jd)};
  const disclosure=indiaLocationDisclosure(context,candidate);
  assert.ok(emailDraft(context,candidate,channel).body.includes(disclosure));
  assert.ok(tailoredResume(context,candidate).html.includes(disclosure));
});
