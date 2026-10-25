import test from 'node:test';
import assert from 'node:assert/strict';
import {triageInternshalaSalesDuties} from '../autonomous/duty-triage.mjs';

const OPEN='Internshala exact-posting JobPosting JSON-LD description (independent source section; retain any differences from body text):\n';
const CLOSE='\n\nInternshala exact-posting JobPosting JSON-LD metadata (verbatim values; country codes are provider data):\n{}';
function capture(duties,{heading="Selected intern's day-to-day responsibilities include:",prefix='',method='internshala-public-html-and-jsonld'}={}) {
  const bullets=duties.map((d,i)=>`${i+1}. ${d}`).join('\n\n');
  return {method,text:`Internshala exact-posting public role text (source: https://internshala.com/internship/detail/example123):\n${prefix}\n\n${OPEN}About the internship:\n${heading}\n\n${bullets}\n\nWho can apply:\nApplicants with relevant interests.\n${CLOSE}`};
}

test('fully sales dominated explicit duties are excluded with source quotes',()=>{
  const input=capture([
    'Make cold calls to prospective customers each day.',
    'Generate new sales leads from outbound prospecting lists.',
    'Close sales deals with qualified customer prospects.',
  ]);
  const result=triageInternshalaSalesDuties(input);
  assert.equal(result?.decision,'excluded');
  assert.equal(result.quotes.length,3);
  assert.equal(result.quotes[0].quote,'Make cold calls to prospective customers each day.');
});

test('three of four explicit sales duties plus a narrow sales admin duty can be excluded',()=>{
  const result=triageInternshalaSalesDuties(capture([
    'Perform telemarketing to prospective buyers daily.',
    'Send bulk email campaigns to sales leads each morning.',
    'Close deals with customers who express interest.',
    'Update call logs in the sales CRM records daily.',
  ]));
  assert.equal(result?.decision,'excluded');assert.equal(result.quotes.length,3);
});

test('research or product work with one lead-generation bullet remains unknown',()=>{
  const result=triageInternshalaSalesDuties(capture([
    'Conduct user research to understand customer needs.',
    'Generate new leads for the growth team.',
    'Analyze product usage and recommend feature improvements.',
  ]));
  assert.equal(result,null);
});

test('negated keywords and strategic exception cannot reject',()=>{
  assert.equal(triageInternshalaSalesDuties(capture([
    'Do not make cold calls to prospective customers.',
    'Generate new leads for the team.',
    'Close deals with interested prospects.',
  ])),null);
  assert.equal(triageInternshalaSalesDuties(capture([
    'Make cold calls to prospective customers.',
    'Generate new leads for the team.',
    'Analyze market research data and propose product strategy.',
  ])),null);
});

test('title and navigation contamination cannot trigger a decision',()=>{
  const input=capture([
    'Conduct market research across target industries.',
    'Analyze user feedback for product improvements.',
    'Plan and coordinate project milestones.',
  ],{prefix:'Cold calling / Lead generation / Close deals / Telemarketing'});
  assert.equal(triageInternshalaSalesDuties(input),null);
});

test('unknown source, absent heading, short list, and malformed numbering return null',()=>{
  const sales=['Make cold calls to prospective customers.','Generate new leads for the team.','Close deals with interested prospects.'];
  assert.equal(triageInternshalaSalesDuties(capture(sales,{method:'other-provider'})),null);
  assert.equal(triageInternshalaSalesDuties(capture(sales,{heading:'About marketing work:'})),null);
  assert.equal(triageInternshalaSalesDuties(capture(sales.slice(0,2))),null);
  const malformed=capture(sales);malformed.text=malformed.text.replace('2. Generate','4. Generate');
  assert.equal(triageInternshalaSalesDuties(malformed),null);
});

test('generic marketing, outreach, and ambiguous additional responsibilities remain unknown',()=>{
  assert.equal(triageInternshalaSalesDuties(capture([
    'Execute marketing campaigns for the product.',
    'Build student community engagement programs.',
    'Track campaign performance and share insights.',
  ])),null);
  assert.equal(triageInternshalaSalesDuties(capture([
    'Make cold calls to prospective customers.',
    'Generate new leads for the team.',
    'Close deals with interested prospects.',
    'Support other business initiatives as assigned.',
  ])),null);
});
