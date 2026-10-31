import test from 'node:test';
import assert from 'node:assert/strict';
import {tailoredResume} from '../autonomous/bundle.mjs';
import {availabilityDisclosure} from '../autonomous/availability.mjs';

const context={sources:{'cv.md':'# Synthetic Student\nApproved research experience.'},profile:{availability:{remote:{earliest_start:'immediate',latest_end:'2027-06-30',max_months:6,max_hours_per_week:40,workplace:'fully remote from India'},summer:{earliest_start:'2027-06-01',latest_end:'2027-07-31',max_months:2,max_hours_per_week:40,workplace:'on-site India or eligible remote'}}},policy:{applyWithStatedAvailability:true}};
test('form PDF source carries primary candidate limits rather than unconfirmed employer schedules',()=>{
  const job={role:'Research Intern',jd:'Employer omits working hours.',track:'remote',hours:null,start:null};
  const result=tailoredResume(context,job),disclosure=availabilityDisclosure(context,job);
  assert.ok(result.html.includes(disclosure));
  assert.equal(result.html.split(disclosure).length,2);
  assert.ok(result.html.includes('not an employer-confirmed schedule'));
  assert.equal(job.hours,null);
  assert.deepEqual(result.claims.map(c=>c.text),['# Synthetic Student','Approved research experience.']);
});
test('summer PDF uses June-July primary limits and generic resume rendering needs no inferred track',()=>{
  const result=tailoredResume(context,{role:'Research Intern',jd:'',track:'summer'});
  assert.ok(result.html.includes('starting 2027-06-01'));
  assert.ok(result.html.includes('no later than 2027-07-31'));
  assert.ok(result.html.includes('up to 2 months'));
  assert.doesNotThrow(()=>tailoredResume(context,{role:'',jd:''}));
});
