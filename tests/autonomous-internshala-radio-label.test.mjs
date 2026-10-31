import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {selectInternshalaRadioOption} from '../autonomous/internshala-transport.mjs';
import {internshalaNativeContract,SANKAR_NATIVE_SLUG,HUMANHIRE_NATIVE_SLUG} from '../autonomous/internshala-contracts.mjs';
const css='<style>.radio{position:relative;width:200px;height:40px}.radio input{position:absolute;left:0;top:0;width:20px;height:20px;margin:0}.radio label{position:absolute;left:0;top:0;width:200px;height:40px;z-index:1;cursor:pointer}</style>';
const html=q=>`${css}<form id="application-form">${q.options.map(o=>`<div class="radio"><input type="radio" name="${q.name}" value="${o.value}" id="${o.value}_fixture"><label for="${o.value}_fixture">${o.label}</label></div>`).join('')}</form>`;
test('provider overlapping labels block direct input checks; ordinary label activation selects the exact Yes/No option',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  for(const [slug,value] of [[SANKAR_NATIVE_SLUG,'Yes'],[HUMANHIRE_NATIVE_SLUG,'No']]) {
   const q=internshalaNativeContract(`https://internshala.com/internship/detail/${slug}`).questions[0];await page.setContent(html(q));
   const input=page.locator(`input[value="${value}"]`);
   await assert.rejects(input.check({timeout:400}),/Timeout/);assert.equal(await page.locator('input:checked').count(),0);
   await selectInternshalaRadioOption(page,q,value);assert.equal(await input.isChecked(),true);assert.equal(await page.locator('input:checked').count(),1);
  }
 } finally {await browser.close();}
});
test('label selection refuses missing, duplicated, mismatched labels and disabled native input',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage(),q=internshalaNativeContract(`https://internshala.com/internship/detail/${SANKAR_NATIVE_SLUG}`).questions[0];
  for(const mutate of [()=>page.locator('label[for="Yes_fixture"]').evaluate(el=>el.remove()),()=>page.locator('label[for="Yes_fixture"]').evaluate(el=>el.after(el.cloneNode(true))),()=>page.locator('label[for="Yes_fixture"]').evaluate(el=>el.textContent='Other'),()=>page.locator('input[value="Yes"]').evaluate(el=>el.disabled=true)]) {
   await page.setContent(html(q));await mutate();await assert.rejects(selectInternshalaRadioOption(page,q,'Yes'));assert.equal(await page.locator('input:checked').count(),0);
  }
 } finally {await browser.close();}
});
