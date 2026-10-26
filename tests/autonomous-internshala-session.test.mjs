import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectStudentSession} from '../autonomous/internshala-session.mjs';
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
