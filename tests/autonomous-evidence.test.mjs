import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quantifiedEvidenceIssues,assess} from '../autonomous/policy.mjs';
test('unknown fit is missing evidence rather than a zero-score rejection',()=>{
  for(const pay of ['paid','unpaid',null]) {
    const result=assess({fit:null,pay,jd:'Synthetic unavailable posting evidence '.repeat(4)}, {tracks:{},minimumFit:4,unpaidFit:4.5},'2026-10-14');
    assert.equal(result.state,'exception');assert.ok(result.reasons.includes('Invalid fit'));
    assert.ok(!result.reasons.some(r=>r.includes('fit below')||r.includes('Fit below')));
  }
});
test('exact but irrelevant quotations cannot establish extracted dates and weekly hours',()=>{
  const job={start:'2027-07-01',end:'2027-08-31',deadline:'2027-06-01',hours:40,evidence:{start:'Start July 1, 2027',end:'Ends 31 August 2027',deadline:'Deadline 2027-06-01',hours:'40 hours per week'}};
  assert.deepEqual(quantifiedEvidenceIssues(job),[]);
  assert.ok(quantifiedEvidenceIssues({...job,start:'2027-07-02'}).some(i=>i.startsWith('start')));
  assert.ok(quantifiedEvidenceIssues({...job,evidence:{...job.evidence,hours:'A full-time internship'}}).some(i=>i.includes('hours')));
  assert.ok(quantifiedEvidenceIssues({...job,evidence:{...job.evidence,start:'Apply by 1 June 2027'}}).some(i=>i.startsWith('start')));
});
