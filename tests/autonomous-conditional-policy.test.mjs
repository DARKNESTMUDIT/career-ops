import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assess, currentSchedule, quantifiedEvidenceIssues} from '../autonomous/policy.mjs';

const today='2026-10-15';
const policy={tracks:{summer:{earliest_start:'2027-07-01',latest_end:'2027-08-31',max_months:2,max_hours_per_week:40}},minimumFit:4,unpaidFit:4.5};
const conditional={...policy,applyWithStatedAvailability:true};
function fixture(overrides={}) {
  const quote='Synthetic Employer Research Intern explicitly welcomes India-based students remotely for substantive paid research. Requirements closely match approved candidate facts.';
  const job={company:'Synthetic Employer',role:'Research Intern',track:'summer',active:true,start:null,end:null,deadline:null,hours:null,indiaEligible:true,studentEligible:true,remote:true,duties:'substantive',pay:'paid',fit:5,...overrides};
  job.evidence=Object.fromEntries(Object.keys(job).map(k=>[k,quote]));
  for(const key of ['start','end','deadline'])if(job[key]!=null)job.evidence[key]=`Explicit ${key}: ${job[key]}`;
  if(job.hours!=null)job.evidence.hours=`Explicit ${job.hours} hours per week`;
  job.jd=[quote,...Object.values(job.evidence)].join('\n');
  return job;
}
test('missing employer schedule remains strict without trusted preference',()=>{
  const result=assess(fixture(),policy,today);
  assert.equal(result.state,'exception');
  for(const key of ['start','end','deadline','hours'])assert.ok(result.reasons.includes(`Missing ${key}`));
  assert.equal(currentSchedule(fixture(),policy,today),false);
});
test('trusted availability allows absent schedule without manufacturing facts',()=>{
  const job=fixture(),before=structuredClone(job);
  assert.equal(assess(job,conditional,today).state,'eligible');
  assert.deepEqual(quantifiedEvidenceIssues(job,conditional),[]);
  assert.equal(currentSchedule(job,conditional,today),true);
  assert.deepEqual(job,before);
  for(const key of ['start','end','deadline','hours'])assert.equal(job[key],null);
});
test('listed fit, duties and remote excerpts must each be exact posting text',()=>{
  const job=fixture(),quote='India-based students; substantive paid research';
  for(const key of ['fit','duties','remote'])job.evidence[key]=quote;
  assert.equal(assess(job,conditional,today).state,'eligible');
  job.evidence.fit+='; Invented requirement';
  assert.ok(assess(job,conditional,today).reasons.includes('Unverified fit evidence'));
  job.evidence.fit=quote+';';
  assert.ok(assess(job,conditional,today).reasons.includes('Unverified fit evidence'));
  job.evidence.fit=quote;job.evidence.company=quote;
  assert.ok(assess(job,conditional,today).reasons.includes('Unverified company evidence'));
});
test('one explicit endpoint is compared without coercing missing endpoint',()=>{
  for(const values of [{start:'2027-07-05'},{end:'2027-08-20'}])assert.equal(assess(fixture(values),conditional,today).state,'eligible');
});
test('explicit contradictions remain rejected',()=>{
  for(const values of [{start:'2027-06-30'},{start:'2027-09-01'},{end:'2027-06-30'},{end:'2027-09-01'},{start:'2027-08-10',end:'2027-08-01'},{deadline:'2026-10-14'},{hours:41},{indiaEligible:false},{studentEligible:false},{remote:false,country:'US'},{duties:'excluded'},{fit:3}]) {
    assert.equal(assess(fixture(values),conditional,today).state,'rejected',JSON.stringify(values));
  }
});
test('explicit numeric evidence and required eligibility facts remain enforced',()=>{
  const job=fixture({start:'2027-07-01',hours:40});
  assert.deepEqual(quantifiedEvidenceIssues(job,conditional),[]);
  job.evidence.start='Requirements closely match approved candidate facts.';
  job.evidence.hours=job.evidence.start;
  assert.equal(quantifiedEvidenceIssues(job,conditional).length,2);
  delete job.evidence.start;
  assert.equal(assess(job,conditional,today).state,'exception');
  for(const key of ['indiaEligible','studentEligible','remote'])assert.equal(assess(fixture({[key]:null}),conditional,today).state,'exception');
  for(const values of [{start:'2027-02-30'},{end:''},{deadline:'unknown'},{hours:'40'}])assert.equal(assess(fixture(values),conditional,today).state,'exception');
});
test('schedule currency rejects past or malformed known dates even with preference',()=>{
  for(const values of [{start:'2026-10-14'},{deadline:'2026-10-14'},{start:'invalid'},{deadline:''}])assert.equal(currentSchedule(fixture(values),conditional,today),false);
  assert.equal(currentSchedule(fixture({start:today,deadline:today}),policy,today),true);
  assert.equal(currentSchedule(fixture({start:'2027-07-01'}),policy,today),false);
});

test('explicit duration remains bounded when employer endpoints are absent',()=>{
  const sixMonths={...conditional,tracks:{summer:{...policy.tracks.summer,max_months:6}}};
  function durationJob(durationMonths,quote) {
    const job=fixture({durationMonths});
    job.evidence.durationMonths=quote;
    job.jd+='\n'+quote;
    return job;
  }
  assert.equal(assess(durationJob(8,'An eight-month research internship.'),sixMonths,today).state,'rejected');
  for(const quote of ['A 3 month internship.','A three-month internship.']) {
    const job=durationJob(3,quote);
    assert.equal(assess(job,sixMonths,today).state,'eligible');
    assert.deepEqual(quantifiedEvidenceIssues(job,sixMonths),[]);
  }
  for(const [value,quote] of [[3,'An eight-month internship.'],[3,'A 1.3 month internship.'],[3,'A -3 month internship.'],[0,'A 0 month internship.'],[-1,'A -1 month internship.'],['3','A 3 month internship.']]) {
    assert.equal(assess(durationJob(value,quote),sixMonths,today).state,'exception');
  }
  const unsupported=durationJob(3,'A three month internship.');
  unsupported.jd=fixture().jd;
  assert.equal(assess(unsupported,sixMonths,today).state,'exception');
  assert.equal(assess(fixture(),sixMonths,today).state,'eligible');
});

test('undisclosed pay needs no quotation of absence while paid and unpaid retain evidence gates',()=>{
  const unknown=fixture({pay:'undisclosed'});
  delete unknown.evidence.pay;
  assert.equal(assess(unknown,conditional,today).state,'eligible');
  unknown.evidence.pay=null;
  assert.equal(assess(unknown,conditional,today).state,'eligible');
  unknown.evidence.pay='A fabricated compensation quotation';
  assert.equal(assess(unknown,conditional,today).state,'exception');
  unknown.evidence.pay='';
  assert.equal(assess(unknown,conditional,today).state,'exception');
  const paid=fixture({pay:'paid'});
  delete paid.evidence.pay;
  assert.equal(assess(paid,conditional,today).state,'exception');
  const unpaid=fixture({pay:'unpaid'});
  const result=assess(unpaid,conditional,today);
  assert.equal(result.state,'exception');
  for(const key of ['credibleEmployer','project','supervision'])assert.ok(result.reasons.includes(`Unpaid ${key} evidence required`));
  delete unpaid.evidence.pay;
  assert.ok(assess(unpaid,conditional,today).reasons.includes('Unverified pay evidence'));
});
