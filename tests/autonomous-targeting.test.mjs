import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prioritizeForProfile} from '../autonomous/targeting.mjs';
const job=(id,role,url=`https://employer.invalid/jobs/${id}`)=>({id,url,payload:{role},state:'discovered'});
const ids=jobs=>jobs.map(j=>j.id);
const profile={target_roles:{primary:['Product Strategy Intern','Consulting Intern'],archetypes:[{name:'Business Research Intern'},{name:"Founder's Office Intern"}]}};

test('approved product and strategy targets precede unrelated sales and engineering discoveries',()=>{
  const jobs=[job('sales','Sales Intern'),job('engineer','Software Engineering Intern'),job('strategy','Strategic Consulting Intern'),job('product','Product Intern'),job('research','Researcher Internship'),job('founder',"Founders Office Intern")];
  const result=prioritizeForProfile(jobs,profile);
  assert.deepEqual(ids(result),['strategy','product','research','founder','sales','engineer']);
  assert.equal(result.length,jobs.length);assert.ok(result.every(j=>jobs.includes(j)));
  assert.deepEqual(ids(jobs),['sales','engineer','strategy','product','research','founder']);
  assert.ok(result.every(j=>j.state==='discovered'));
});

test('different approved profile prioritizes engineering instead of product or strategy',()=>{
  const jobs=[job('product','Product Strategy Intern'),job('sales','Sales Intern'),job('engineering','Software Engineer Intern'),job('developer','Backend Developer Intern')];
  assert.deepEqual(ids(prioritizeForProfile(jobs,{target_roles:{primary:['Software Engineering Intern'],archetypes:[{name:'Backend Development Intern'}]}})),['engineering','developer','product','sales']);
});

test('decoded URL path contributes role title signals without host or query preferences',()=>{
  const jobs=[job('sales','Intern','https://product.invalid/jobs/sales?role=product'),job('strategy',undefined,'https://employer.invalid/jobs/strategy%20consulting-intern'),job('product',undefined,'https://employer.invalid/jobs/product-management-intern')];
  assert.deepEqual(ids(prioritizeForProfile(jobs,profile)),['strategy','product','sales']);
});

test('missing targeting preserves input order and generic words do not become preferences',()=>{
  const jobs=[job('sales','Office Sales Intern'),job('product','Product Intern'),job('other','Application Intern')];
  for(const empty of [undefined,{}, {target_roles:{}},{target_roles:{primary:'Product Intern'}},{target_roles:{primary:['Intern Office Application Role']}}])assert.deepEqual(ids(prioritizeForProfile(jobs,empty)),ids(jobs));
  assert.notEqual(prioritizeForProfile(jobs,{}),jobs);
});

test('malformed URLs and malformed target entries remain safe and ties stay stable',()=>{
  const jobs=[job('bad',undefined,'not a URL'),job('broken-escape','Research Intern','https://employer.invalid/%E0%A4%A'),job('valid','Research Intern'),job('empty',null,null)];
  assert.deepEqual(ids(prioritizeForProfile(jobs,{target_roles:{primary:[null,42,'Research Intern'],archetypes:[null,{},42]}})),['broken-escape','valid','bad','empty']);
});
