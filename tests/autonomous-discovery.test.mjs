import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchUnstopPosting} from '../autonomous/unstop.mjs';
import {htmlToText} from '../providers/_html-to-text.mjs';
import {fetchSmartRecruitersPosting} from '../autonomous/smartrecruiters.mjs';
import {adapterFor} from '../autonomous/browser.mjs';
import {fetchFullPosting} from '../autonomous/discovery.mjs';
test('full-description opt-in preserves default provider cap',()=>{
  assert.equal(htmlToText('x'.repeat(6000)).length,4000);
  assert.equal(htmlToText('x'.repeat(6000),{maxChars:50000}).length,6000);
});
test('SmartRecruiters full capture binds identity and preserves qualifications without enabling submission',async()=>{
  const url='https://jobs.smartrecruiters.com/EXAMPLE/123-intern';
  const item={id:'123',company:{identifier:'EXAMPLE',name:'Example'},postingUrl:url,active:true,visibility:'PUBLIC',location:{city:'Example City'},typeOfEmployment:{label:'Full-time'},releasedDate:'2026-10-01',jobAd:{sections:{jobDescription:{text:'<p>'+ 'Substantive research duties. '.repeat(200)+'</p>'},qualifications:{text:'<p>Specific qualification required.</p>'}}}};
  const fetcher=async()=>({ok:true,json:async()=>item});
  const capture=await fetchSmartRecruitersPosting(url,{fetcher});
  assert.ok(capture.text.includes('Specific qualification required.'));
  assert.ok(capture.text.includes('release date is NOT an internship start date'));
  assert.ok(!capture.text.includes('Remote'));assert.ok(!capture.text.includes('40'));
  assert.equal(adapterFor(url),null);
  await assert.rejects(fetchFullPosting('https://jobs.smartrecruiters.com/EXAMPLE/'),/Exact SmartRecruiters posting URL required/);
  assert.equal(await fetchSmartRecruitersPosting(url.replace('jobs.smartrecruiters.com','jobs.smartrecruiters.com.evil.invalid'),{fetcher:()=>{throw new Error('Unexpected request');}}),null);
  item.company.identifier='OTHER';await assert.rejects(fetchSmartRecruitersPosting(url,{fetcher}),/identity mismatch/);
  item.company.identifier='EXAMPLE';item.visibility='INTERNAL';await assert.rejects(fetchSmartRecruitersPosting(url,{fetcher}),/public and active/);
  item.visibility='PUBLIC';delete item.jobAd.sections.qualifications;await assert.rejects(fetchSmartRecruitersPosting(url,{fetcher}),/qualifications unavailable/);
});
test('Unstop exact-ID API capture preserves requirements and raw location, not inferred remote',async()=>{
  const url='https://unstop.com/internships/product-management-internship-example-123';
  const item={id:123,seo_url:url,details:`<p>${'Role description. '.repeat(300)}</p><p>MBA required.</p>`,title:'Product Management Internship',organisation:{name:'Example'},jobDetail:{type:'in_office',timing:'full_time'},regnRequirements:{end_regn_dt:'2026-12-01T00:00:00+05:30',reg_status:'STARTED'}};
  const fetcher=async()=>({ok:true,json:async()=>({data:{data:[item]}})});
  const capture=await fetchUnstopPosting(url,{fetcher});
  assert.ok(capture.text.includes('MBA required.'));assert.ok(capture.text.includes('in_office'));
  assert.ok(capture.text.includes('registration dates are NOT internship dates'));
  assert.ok(!capture.text.includes('Remote'));
  assert.equal(await fetchUnstopPosting(url.replace('example-123','other-123'),{fetcher}),null);
});
