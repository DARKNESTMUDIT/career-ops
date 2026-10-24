import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchIsocodePosting,ISOCODE_POSTING_URL as url} from '../autonomous/isocode-posting.mjs';

const job={
  '@type':'JobPosting',title:'Product Management Intern',identifier:{value:'product-manager-intern'},
  hiringOrganization:{name:'Synthetic Studio'},url,
  description:'<p>Research product problems and write clear specifications. Work with the team on priorities, user interviews, delivery and practical product experiments.</p>',
  applicantLocationRequirements:{'@type':'Country',name:'India'},educationRequirements:'Synthetic explicit education restriction',
};
const document=(value=job)=>`<h1>Product Management Intern</h1><script type="application/ld+json">${JSON.stringify(value)}</script><script>window.data={"roleKey":"product-manager-intern","status":"open"}</script>`;
const page=html=>new Response(html,{headers:{'content-type':'text/html'}});

test('exact source preserves full description and structured education restrictions',async()=>{
  const capture=await fetchIsocodePosting(url,{fetcher:async(target,options)=>{assert.equal(target,url);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');return page(document());}});
  assert.ok(capture.text.includes('Synthetic explicit education restriction'));
  assert.ok(capture.text.includes('Research product problems'));
  assert.ok(capture.text.includes('"name":"India"'));
});
test('other sources cannot trigger requests',async()=>{
  assert.equal(await fetchIsocodePosting(url+'/other',{fetcher:()=>assert.fail('unexpected request')}),null);
});
test('wrong role, ambiguous postings, closed status and challenges fail closed',async()=>{
  for(const html of [document({...job,identifier:{value:'other'}}),document([job,job]),document().replace('"status":"open"','"status":"closed"'),document()+'<p>Applications are closed</p>',document()+'<p>Verify you are human</p>']) {
    await assert.rejects(fetchIsocodePosting(url,{fetcher:async()=>page(html)}));
  }
});
test('expired, missing and oversized requirements do not qualify',async()=>{
  for(const value of [{...job,validThrough:'2000-01-01'},{...job,description:'short'},{...job,description:'x'.repeat(50000)}])await assert.rejects(fetchIsocodePosting(url,{fetcher:async()=>page(document(value))}));
  await assert.rejects(fetchIsocodePosting(url,{fetcher:async()=>page(document()+'x'.repeat(1048576))}));
});
