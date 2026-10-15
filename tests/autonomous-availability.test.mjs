import {test} from 'node:test';
import assert from 'node:assert/strict';
import {availabilityDisclosure,productMotivation} from '../autonomous/availability.mjs';

const fixture = () => ({policy:{applyWithStatedAvailability:true},profile:{availability:{
  remote:{earliest_start:'immediate',latest_end:'2027-06-30',max_months:6,max_hours_per_week:35,workplace:'fully remote from India'},
  summer:{earliest_start:'2027-07-01',latest_end:'2027-08-31',max_months:2,max_hours_per_week:40,workplace:'on-site in India'}
},target_roles:{primary:['Product Intern']},narrative:{exit_story:'I want to move toward product work.'}}});

test('disclosure states exact primary candidate limits for both tracks and requests employer confirmation',()=>{
  const context=fixture();
  assert.equal(availabilityDisclosure(context,{track:'remote'}),'My availability is fully remote from India, starting immediately, for up to 6 months, ending no later than 2027-06-30, and up to 35 hours per week. These are my candidate availability limits; they are not an employer-confirmed schedule. Please confirm whether the role can accommodate this availability.');
  const summer=availabilityDisclosure(context,{track:'summer'});
  for(const expected of ['on-site in India','starting 2027-07-01','up to 2 months','no later than 2027-08-31','up to 40 hours per week','not an employer-confirmed schedule','Please confirm'])assert.ok(summer.includes(expected));
});
test('posting dates, hours, workplace and copied availability never become candidate facts',()=>{
  const context=fixture(),before=structuredClone(context);
  const untrusted={track:'remote',hours:999,start:'2099-01-01',end:'2099-12-31',workplace:'Moon base',availability:{max_hours_per_week:999}};
  assert.equal(availabilityDisclosure(context,untrusted),availabilityDisclosure(context,{track:'remote'}));
  assert.deepEqual(context,before);
});
test('disabled policy produces no disclosure and does not require or guess configuration',()=>{
  for(const context of [undefined,{}, {policy:{}},{policy:{applyWithStatedAvailability:false}}, {policy:{applyWithStatedAvailability:'true'}}])assert.equal(availabilityDisclosure(context,{track:'remote'}),'');
});
test('enabled policy refuses absent or malformed primary availability and unknown tracks',()=>{
  for(const track of [undefined,'other','__proto__'])assert.throws(()=>availabilityDisclosure(fixture(),{track}),/track required/);
  for(const value of [undefined,null,[],{}]){
    const context=fixture();context.profile.availability.remote=value;
    assert.throws(()=>availabilityDisclosure(context,{track:'remote'}),/configuration/);
  }
  const malformed={earliest_start:['soon','2027-02-30','2028-01-01',null],latest_end:['2027-02-30','tomorrow',null],max_months:[0,-1,13,Infinity,'6'],max_hours_per_week:[0,-1,169,NaN,'40'],workplace:['','  ',null,12,'remote\nInvented claim']};
  for(const [key,values] of Object.entries(malformed))for(const value of values){
    const context=fixture();context.profile.availability.remote[key]=value;
    assert.throws(()=>availabilityDisclosure(context,{track:'remote'}),/malformed/,key+': '+String(value));
  }
  const noProfile=fixture();delete noProfile.profile;assert.throws(()=>availabilityDisclosure(noProfile,{track:'remote'}),/configuration required/);
});
test('product motivation requires both primary targeting and product narrative, and expresses aspiration only',()=>{
  const context=fixture();context.profile.narrative.exit_story='Product leadership across 999 teams';
  assert.equal(productMotivation(context),'I am interested in product work and hope to learn more about product discovery and prioritization through this opportunity.');
  assert.ok(!productMotivation(context).includes('999'));
  for(const invalid of [{},{profile:{target_roles:{primary:['Engineer']},narrative:{exit_story:'Product work'}}},{profile:{target_roles:{primary:['Product Intern']},narrative:{exit_story:'Engineering work'}}},{profile:{target_roles:{primary:'Product Intern'},narrative:{exit_story:'Product work'}}}])assert.equal(productMotivation(invalid),'');
});
