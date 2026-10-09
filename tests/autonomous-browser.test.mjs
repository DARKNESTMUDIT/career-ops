import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { adapterFor, answerField, prepareForm } from '../autonomous/browser.mjs';
const profile = {candidate:{full_name:'Example Candidate', email:'candidate@example.invalid',phone:'+910000000000',portfolio_url:'https://example.invalid'}};
test('adapter host allowlist rejects lookalikes and insecure URLs', () => {
  assert.equal(adapterFor('https://job-boards.greenhouse.io/a/jobs/1'),'greenhouse');
  assert.equal(adapterFor('https://jobs.lever.co/a/1'),'lever');
  assert.equal(adapterFor('https://jobs.ashbyhq.com/a/1'),'ashby');
  assert.equal(adapterFor('https://jobs.lever.co.attacker.invalid/a/1'),null);
  assert.equal(adapterFor('http://jobs.lever.co/a/1'),null);
});
test('unknown mandatory declarations and optional demographics do not get guessed', () => {
  assert.equal(answerField({label:'Gender',required:false},profile).skip,true);
  assert.equal(answerField({label:'Work authorization',required:true},profile).skip,false);
  assert.equal(answerField({label:'Email',required:true},profile).value,profile.candidate.email);
});
test('real browser fills and verifies fields/uploads, surfaces unknown required questions', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'form-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const pdf=path.join(dir,'resume.pdf');fs.writeFileSync(pdf,'%PDF-1.4 fixture only');
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent('<form><label>Full name<input required></label><label>Email<input type="email" required></label><label>Resume<input type="file" required></label><label>Gender<input></label><button type="submit">Submit application</button></form>');
  const prepared=await prepareForm(page,profile,pdf);
  assert.equal(prepared.complete,true); assert.equal(prepared.answers.length,3);
  assert.equal(await page.getByLabel('Full name').inputValue(),'Example Candidate');
  assert.equal(await page.getByLabel('Gender').inputValue(),'');
  await page.locator('form').evaluate(el=>{ const l=document.createElement('label');l.textContent='Unknown personal answer';const i=document.createElement('input');i.required=true;l.append(i);el.append(l); });
  const blocked=await prepareForm(page,profile,pdf); assert.equal(blocked.complete,false);assert.match(blocked.issues.join(),/Unknown/);
});
