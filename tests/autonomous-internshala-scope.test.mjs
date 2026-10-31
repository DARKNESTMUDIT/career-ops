import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeSubmission} from '../autonomous/rollout.mjs';

test('provider label cannot expand native certification to another role or unsafe source URL',()=>{
  for(const url of [
    'https://internshala.com/internship/detail/other-role',
    'https://internshala.com/internship/detail/work-from-home-general-management-internship-at-arh-tubes-and-profiles-pvt-ltd1792564453?unreviewed=1',
    'https://internshala.com.evil.invalid/internship/detail/work-from-home-general-management-internship-at-arh-tubes-and-profiles-pvt-ltd1792564453',
  ]) {
    let touched=false;
    const ledger={job:()=>({url}),jobs:()=>{touched=true;throw Error('Scope must fail before other work');}};
    assert.throws(()=>authorizeSubmission(ledger,'synthetic',{},'internshala'),/certification scope/);
    assert.equal(touched,false);
  }
});
