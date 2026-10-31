import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectStudentSession,internshalaSessionLaunchOptions} from '../autonomous/internshala-session.mjs';
test('authenticated profile uses visible Chrome and OS Keychain without weakening browser protections',()=>{
  const options=internshalaSessionLaunchOptions();
  assert.equal(options.channel,'chrome');
  assert.equal(options.headless,false);
  assert.equal(options.chromiumSandbox,true);
  assert.equal(options.serviceWorkers,'block');
  assert.deepEqual(options.ignoreDefaultArgs,['--use-mock-keychain','--password-store=basic']);
  assert.equal(options.args,undefined);
});
function page(url='https://internshala.com/student/resume',text='Synthetic Student\nstudent@example.invalid',count=1){return{url:()=>url,locator:()=>({count:async()=>count,innerText:async()=>text})};}
test('student session checks exact protected origin/path and primary account',async()=>{
  assert.deepEqual(await inspectStudentSession(page(),'student@example.invalid'),{connected:true,accountMatched:true});
  for(const url of ['https://internshala.com/login','https://internshala.com.evil.invalid/student/resume','http://internshala.com/student/resume','https://internshala.com/student/resume-copy'])assert.deepEqual(await inspectStudentSession(page(url),'student@example.invalid'),{connected:false});
});
test('missing resume, mismatched account or blank primary email cannot establish authentication',async()=>{
  assert.deepEqual(await inspectStudentSession(page(undefined,undefined,0),'student@example.invalid'),{connected:false});
  await assert.rejects(inspectStudentSession(page(),'someone-else@example.invalid'),/does not match/);
  for(const email of ['',null,'not an email'])await assert.rejects(inspectStudentSession(page(),email),/Primary account email/);
});
