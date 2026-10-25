import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fetchHyperprospectPosting,HYPERPROSPECT_CAREERS_URL as url,HYPERPROSPECT_APPLICATION_MAILTO as mailto} from '../autonomous/hyperprospect-posting.mjs';

const globalPolicy='Work from wherever you do your best thinking. We optimise for async work, deep research and trust over timezones. Output matters; where you sit does not.';
const roleDetails='Work alongside founders on product and operations research. Write decision memos, analyze new opportunities and build internal processes. Coordinate teams and keep projects moving while learning how a small software company operates.';
const other='<div class="acc-item"><div class="acc-head"><div class="t">Growth Marketing Associate</div><div class="meta">Full WFH · India · Pune</div></div><div class="acc-body">Must live in India. Applicants require an MBA. <a href="mailto:other@example.invalid?subject=Application: Growth">Apply now</a></div></div>';
const card=({role="Founder's Office Intern",details=roleDetails,href=mailto,links='',chips='<span>Remote</span><span>Internship</span><span>Operations</span>'}={})=>`<div class="acc-item"><div class="acc-head"><div class="t">${role}</div><div class="meta">${chips}</div></div><div class="acc-body"><div class="acc-body-inner"><p>${details}</p><a href="${href}">Apply now</a>${links}</div></div></div>`;
function document({role=card(),policy=globalPolicy,adjacent=other,extra='',title='Careers at HyperProspect — Synthetic'}={}) {
 return `<html><head><title>${title}</title></head><body><nav>Other roles in India</nav><div class="card"><h3>Remote-first, always</h3><p>${policy}</p></div><section class="roles">${adjacent}${role}${extra}</section><footer>HyperProspect, USA</footer></body></html>`;
}
const response=(html,status=200,headers={})=>new Response(html,{status,headers:{'content-type':'text/html',...headers}});
const fetcher=html=>async(target,options)=>{assert.equal(target,url);assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.headers.Accept,'text/html');assert.ok(options.signal instanceof AbortSignal);return response(html);};

test('exact role, policy and native email are captured without adjacent India or degree claims',async()=>{
 const capture=await fetchHyperprospectPosting(url,{fetcher:fetcher(document())});
 assert.equal(capture.sourceUrl,url);
 assert.equal(capture.method,'hyperprospect-public-careers-exact-role');
 assert.match(capture.text,/Work alongside founders on product and operations research/);
 assert.match(capture.text,/Company-wide remote work policy \(not role-specific geographic eligibility\)/);
 assert.match(capture.text,/Work from wherever you do your best thinking/);
 assert.match(capture.text,/"recipient":"support@hyperprospect.com"/);
 assert.match(capture.text,/"subject":"Application: Founder's Office Intern"/);
 assert.doesNotMatch(capture.text,/India|Pune|MBA|Growth Marketing Associate|other@example.invalid|USA/);
 assert.equal(capture.sourceHash,createHash('sha256').update(capture.text).digest('hex'));
});

test('only the exact careers URL triggers a request',async()=>{
 for(const value of [url+'/',url+'?role=founder',url.replace('https:','http:'),'https://other.invalid/careers'])assert.equal(await fetchHyperprospectPosting(value,{fetcher:()=>assert.fail('unexpected request')}),null);
});

test('changed role, repeated role, missing details or ambiguous policy fail closed',async()=>{
 for(const html of [
  document({role:card({role:'Operations Intern'})}),
  document({extra:card()}),
  document({role:card({details:'short'})}),
  document({policy:'short'}),
  document({extra:`<div class="card"><h3>Remote-first, always</h3><p>${globalPolicy}</p></div>`}),
  document({title:'Careers at Other Company'}),
 ])await assert.rejects(fetchHyperprospectPosting(url,{fetcher:fetcher(html)}));
});

test('recipient, full subject, multiple links and changed chips fail closed',async()=>{
 for(const html of [
  document({role:card({href:'mailto:support@hyperprospect.com?subject=Application: Open Application'})}),
  document({role:card({href:'mailto:other@hyperprospect.com?subject=Application: Founder\'s Office Intern'})}),
  document({role:card({links:'<a href="mailto:support@hyperprospect.com?subject=General">Second link</a>'})}),
  document({role:card({chips:'<span>On-site</span><span>Internship</span><span>Operations</span>'})}),
 ])await assert.rejects(fetchHyperprospectPosting(url,{fetcher:fetcher(html)}));
});

test('closed, challenged, expired and oversized sources fail closed',async()=>{
 for(const html of [
  document({role:card({details:roleDetails+' Applications are closed.'})}),
  document({role:card({details:roleDetails+' Role expired.'})}),
  document({extra:'<div>Verify you are human</div>'}),
  document({role:card({details:roleDetails+'x'.repeat(50000)})}),
  document()+'x'.repeat(1048576),
 ])await assert.rejects(fetchHyperprospectPosting(url,{fetcher:fetcher(html)}));
});

test('redirect, non-HTML, missing body and response identity mismatch fail closed',async()=>{
 await assert.rejects(fetchHyperprospectPosting(url,{fetcher:async()=>new Response(null,{status:302,headers:{location:'https://other.invalid/'}})}));
 await assert.rejects(fetchHyperprospectPosting(url,{fetcher:async()=>response(document(),200,{'content-type':'application/json'})}));
 await assert.rejects(fetchHyperprospectPosting(url,{fetcher:fetcher('<html><head><title>Careers at HyperProspect</title></head>')}));
 await assert.rejects(fetchHyperprospectPosting(url,{fetcher:async()=>({url:'https://other.invalid/careers',status:200,headers:new Headers({'content-type':'text/html'}),body:response(document()).body})}));
});
