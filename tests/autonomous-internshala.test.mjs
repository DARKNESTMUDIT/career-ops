import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchInternshalaPosting} from '../autonomous/internshala.mjs';
// Minimal public-source excerpts retrieved by GET on 2026-10-23: under 80
// quoted words per source. Additional description context is original synthetic
// text, explicitly labelled below; no complete vendor description is retained.
const records={
 whatbytes:{'@type':'JobPosting',title:'Product Management - Internship (WFH)',description:'<p>Who can apply:</p><ol><li>are available for the work from home job/internship</li><li>have relevant skills and interests</li><li>are Computer Science Engineering students</li></ol><p>Synthetic fixture context: the team examines a small product experiment and documents requirements clearly. This additional context is original test text.</p>',identifier:{'@type':'PropertyValue',name:'Whatbytes',value:'20263312908'},applicantLocationRequirements:{'@type':'Country',name:'IN'},jobLocationType:'TELECOMMUTE',hiringOrganization:{'@type':'Organization',name:'Whatbytes'}},
 echotalk:{'@type':'JobPosting',title:'Product Management - Internship (WFH)',description:'<p>Who can apply:</p><ol><li>are available for the work from home job/internship</li><li>have relevant skills and interests</li><li>are Computer Science Engineering students</li></ol><p>Synthetic fixture context: the team discusses a small usability experiment and records product questions. This additional context is original test text.</p>',identifier:{'@type':'PropertyValue',name:'Echotalk',value:'20263316935'},applicantLocationRequirements:{'@type':'Country',name:'IN'},jobLocationType:'TELECOMMUTE',hiringOrganization:{'@type':'Organization',name:'Echotalk'}}
};
const urls={whatbytes:'https://internshala.com/internship/detail/work-from-home-product-management-internship-at-whatbytes1791393727',echotalk:'https://internshala.com/internship/detail/work-from-home-product-management-internship-at-echotalk1791960703'};
const body='<h1>Product Management - Internship (WFH)</h1><p>Work from home</p><h2>Who can apply</h2><p>Only those candidates can apply who:</p><ol><li>are available for the work from home job/internship</li><li>have relevant skills and interests</li></ol>';
function page({url=urls.whatbytes,posting=records.whatbytes,extra=[],canonical=true,breadcrumb=false,visible=body,outside=''}={}) {
 const schemas=[posting,...extra].filter(Boolean);
 if(breadcrumb)schemas.push({'@type':'BreadcrumbList',itemListElement:[{position:1,item:'https://internshala.com/'},{position:2,item:url}]});
 return `<html><head>${canonical?`<link rel='canonical' href='${url}'>`:''}${schemas.map(schema=>`<script type="application/ld+json">${JSON.stringify(schema)}</script>`).join('')}</head><body>${outside}<div class="detail_view"><div class="internship_meta"><h1>Product Management - Internship (WFH)</h1><p>Work from home</p></div><div class="internship_details">${visible}</div></div></body></html>`;
}
function response(html,status=200,headers={}) {return new Response(html,{status,headers:{'content-type':'text/html',...headers}});}
function fetcher(html){return async (url,options)=>{assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.ok(options.signal instanceof AbortSignal);return response(html);};}
test('minimal source excerpts retain explicit IN, TELECOMMUTE and Computer Science Engineering student requirement',async()=>{
 for(const [company,url] of Object.entries(urls)) {
  const capture=await fetchInternshalaPosting(url,{fetcher:fetcher(page({url,posting:records[company]}))});
  assert.equal(capture.sourceUrl,url);assert.equal(capture.method,'internshala-public-html-and-jsonld');
  assert.match(capture.text,/are Computer Science Engineering students/);assert.match(capture.text,/"applicantLocationRequirements":\{"@type":"Country","name":"IN"\}/);assert.match(capture.text,/"jobLocationType":"TELECOMMUTE"/);
  assert.match(capture.text,/Only those candidates can apply who/);assert.match(capture.text,/JobPosting JSON-LD description/);assert.ok(capture.text.length<50000);
 }
});
test('retains contradictory body and structured qualifications without inventing a resolution',async()=>{
 const capture=await fetchInternshalaPosting(urls.whatbytes,{fetcher:fetcher(page({visible:body+'<p>Synthetic body requirement: all disciplines.</p>',posting:{...records.whatbytes,qualifications:'Synthetic structured requirement: Computer Science only.',educationRequirements:{'@type':'EducationalOccupationalCredential',credentialCategory:'Synthetic college enrolment'}}}))});
 assert.match(capture.text,/Synthetic body requirement: all disciplines/);assert.match(capture.text,/Synthetic structured requirement: Computer Science only/);assert.match(capture.text,/Synthetic college enrolment/);
});
test('navigation degrees and related roles stay out while role-only and JSON-LD requirements remain',async()=>{
 const outside='<nav><a>Online MBA</a><a>Online BCA</a><a>Online MCA</a><a>Online BBA</a></nav><aside>Similar internships: Master degree required for a different role.</aside><footer>Degree courses</footer>';
 const visible=body+'<p>Applicants must be pursuing a B.Tech degree in design engineering.</p>';
 const capture=await fetchInternshalaPosting(urls.whatbytes,{fetcher:fetcher(page({visible,outside}))});
 assert.doesNotMatch(capture.text,/Online MBA|Online BCA|Online MCA|Online BBA|Similar internships|different role|Degree courses/);
 assert.match(capture.text,/Applicants must be pursuing a B.Tech degree in design engineering/);
 assert.match(capture.text,/are Computer Science Engineering students/);
});
test('an unrelated recommended JobPosting is never merged into the exact addressed current posting',async()=>{
 const capture=await fetchInternshalaPosting(urls.whatbytes,{fetcher:fetcher(page({posting:{...records.whatbytes,url:urls.whatbytes},extra:[{...records.echotalk,url:urls.echotalk,description:'UNRELATED RECOMMENDED ROLE '.repeat(20),qualifications:'UNRELATED QUALIFICATION'}]}))});
 assert.match(capture.text,/Whatbytes/);assert.doesNotMatch(capture.text,/UNRELATED|Echotalk/);
});
test('a missing or duplicated production role container fails closed',async()=>{
 const valid=page();
 for(const html of [
  valid.replace('class="detail_view"','class="other_view"'),
  valid.replace('class="internship_meta"','class="other_meta"'),
  valid.replace('class="internship_details"','class="other_details"'),
  valid.replace('</body>','<div class="detail_view"><div class="internship_meta"></div><div class="internship_details"></div></div></body>'),
 ])await assert.rejects(fetchInternshalaPosting(urls.whatbytes,{fetcher:fetcher(html)}),/container missing or ambiguous/);
});
test('rejects unmatched, ambiguous, malformed and unbound structured postings',async()=>{
 for(const html of [page({url:urls.echotalk}),page({posting:{...records.whatbytes,url:urls.echotalk}}),page({extra:[records.echotalk]}),page({canonical:false}),page().replace('"@type":"JobPosting"','malformed-json')])await assert.rejects(fetchInternshalaPosting(urls.whatbytes,{fetcher:fetcher(html)}),/identity|unmatched|ambiguous|malformed/);
});
test('exact terminal Breadcrumb can bind a unique unaddressed JobPosting; absence permits normal fallback',async()=>{
 const capture=await fetchInternshalaPosting(urls.whatbytes,{fetcher:fetcher(page({canonical:false,breadcrumb:true}))});assert.match(capture.text,/Computer Science Engineering students/);
 assert.equal(await fetchInternshalaPosting(urls.whatbytes,{fetcher:fetcher(page({posting:null}))}),null);
 for(const url of [urls.whatbytes.replace('https:','http:'),urls.whatbytes.replace('internshala.com','internshala.com.attacker.invalid'),urls.whatbytes+'?job=other',urls.whatbytes.replace('/internship/detail/','/jobs/')])assert.equal(await fetchInternshalaPosting(url,{fetcher:()=>{throw Error('Unsupported URL must not fetch')}}),null);
});
test('manual redirects stay on exact HTTPS posting identity and are bounded',async()=>{
 let requests=0;const same=urls.whatbytes.replace('whatbytes','whatbytes-renamed');
 const capture=await fetchInternshalaPosting(urls.whatbytes,{fetcher:async url=>{requests++;return url===urls.whatbytes?new Response(null,{status:302,headers:{location:same}}):response(page());}});assert.equal(requests,2);assert.match(capture.text,/Computer Science Engineering students/);
 for(const destination of [urls.echotalk,urls.whatbytes.replace('https:','http:'),'https://attacker.invalid/'])await assert.rejects(fetchInternshalaPosting(urls.whatbytes,{fetcher:async()=>new Response(null,{status:302,headers:{location:destination}})}),/redirect left/);
 await assert.rejects(fetchInternshalaPosting(urls.whatbytes,{fetcher:async()=>new Response(null,{status:302,headers:{location:urls.whatbytes}})}),/redirect limit/);
});
test('rejects oversized HTML/text, truncated body, expired metadata and CAPTCHA',async()=>{
 await assert.rejects(fetchInternshalaPosting(urls.whatbytes,{fetcher:fetcher('x'.repeat(1048577))}),/1 MB/);
 await assert.rejects(fetchInternshalaPosting(urls.whatbytes,{fetcher:fetcher(page({visible:body+'x'.repeat(50000)}))}),/50,000/);
 await assert.rejects(fetchInternshalaPosting(urls.whatbytes,{fetcher:fetcher(page().replace('</body>',''))}),/truncated/);
 await assert.rejects(fetchInternshalaPosting(urls.whatbytes,{fetcher:fetcher(page({posting:{...records.whatbytes,validThrough:'2000-01-01'}}))}),/expired/);
 await assert.rejects(fetchInternshalaPosting(urls.whatbytes,{fetcher:fetcher(page({visible:body+'Verify you are human'}))}),/requires interaction/);
 await assert.rejects(fetchInternshalaPosting(urls.whatbytes,{fetcher:async()=>response('',410)}),/expired/);
});
