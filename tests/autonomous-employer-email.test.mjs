import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchEmployerEmailPosting } from '../autonomous/employer-email.mjs';

const url = 'https://employer.com/careers/product-intern';
const quote = 'Send your resume or LinkedIn profile to careers@employer.com';
const channel = { verified: true, roleUrl: url, sourceUrl: url, employerHost: 'employer.com', role: 'Product Intern', recipient: 'careers@employer.com', quote, postingHash: 'previous-version' };
const html = `<html><h1>Product Intern</h1><p>Help build our product and research customer needs.</p><p>${quote}</p></html>`;
const page = (body = html, headers = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

test('reviewed role captures visible full text independently of previous hash', async () => {
  const calls = [];
  const result = await fetchEmployerEmailPosting(url, channel, { fetcher: async (target, options) => { calls.push(target); assert.equal(options.redirect, 'manual'); assert.ok(options.signal instanceof AbortSignal); return page(); } });
  assert.deepEqual(calls, [url]);
  assert.equal(result.method, 'employer-email-page');
  assert.equal(result.sourceUrl, url);
  assert.equal(result.text, `Product Intern Help build our product and research customer needs. ${quote}`);
});

test('unreviewed or mismatched channel cannot trigger a fetch', async () => {
  for (const changed of [{ verified: false }, { roleUrl: url + '/other' }, { sourceUrl: 'https://other.com/' }, { employerHost: 'other.com' }, { recipient: 'not-email' }, { quote: 'Apply now' }, { role: '' }]) {
    assert.equal(await fetchEmployerEmailPosting(url, { ...channel, ...changed }, { fetcher: () => { assert.fail('must not fetch'); } }), null);
  }
});

test('private, IP and non-HTTPS URLs cannot trigger a fetch', async () => {
  for (const unsafe of ['http://employer.com/job', 'https://127.0.0.1/job', 'https://[::1]/job', 'https://localhost/job', 'https://jobs.internal/job', 'https://jobs.local/job', 'https://employer.com:444/job', 'https://user:pass@employer.com/job']) {
    const host = new URL(unsafe).hostname;
    assert.equal(await fetchEmployerEmailPosting(unsafe, { ...channel, roleUrl: unsafe, sourceUrl: unsafe, employerHost: host }, { fetcher: () => { assert.fail('must not fetch'); } }), null);
  }
});

test('same-origin redirects are bounded to two and cross-origin redirects are denied', async () => {
  let calls = 0;
  const result = await fetchEmployerEmailPosting(url, channel, { fetcher: async () => ++calls <= 2 ? new Response(null, { status: 302, headers: { location: '/careers/current' } }) : page() });
  assert.ok(result);
  assert.equal(calls, 3);
  calls = 0;
  assert.equal(await fetchEmployerEmailPosting(url, channel, { fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://other.com/job' } }); } }), null);
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(await fetchEmployerEmailPosting(url, channel, { fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location: '/again' } }); } }), null);
  assert.equal(calls, 3);
});

test('missing evidence, closed roles, captcha and invalid responses fail closed', async () => {
  for (const body of [html.replace(quote, 'Apply here'), html.replace('Product Intern', 'Engineer'), html + '<p>Applications are closed</p>', html + '<p>Verify you are human</p>', `<script>${quote}</script><h1>Product Intern</h1>`, html + '<p>This position has been filled</p>']) {
    assert.equal(await fetchEmployerEmailPosting(url, channel, { fetcher: async () => page(body) }), null);
  }
  for (const response of [new Response(html, { status: 404 }), new Response(html, { headers: { 'content-type': 'application/json' } }), page(html, { 'content-length': '1048577' }), page('a'.repeat(1048577)), page(html + 'a'.repeat(50000))]) {
    assert.equal(await fetchEmployerEmailPosting(url, channel, { fetcher: async () => response }), null);
  }
  assert.equal(await fetchEmployerEmailPosting(url, channel, { fetcher: async () => { throw new Error('network failure'); } }), null);
});

const applicationSubject = 'Application for Product Intern Position';
const applicationBody = 'Hi,\r\nI am interested in the Product Intern position.\r\nName: [Your Name]';
const mailtoEvidence = `Published application mailto: ${JSON.stringify({ recipient: channel.recipient, subject: applicationSubject, body: applicationBody })}`;
const mailtoChannel = { ...channel, quote: mailtoEvidence };
const applicationHref = `mailto:${channel.recipient}?subject=${encodeURIComponent(applicationSubject)}&amp;body=${encodeURIComponent(applicationBody)}`;
const mailtoPage = href => `<h1>Product Intern</h1><p>Help build products.</p><a href="${href}">Apply via Email</a>`;

test('reviewed role captures decoded href-only recipient, subject and body as deterministic evidence', async () => {
  const result = await fetchEmployerEmailPosting(url, mailtoChannel, { fetcher: async () => page(mailtoPage(applicationHref)) });
  assert.equal(result.text, `Product Intern Help build products. Apply via Email\n${mailtoEvidence}`);
  const captured = JSON.parse(result.text.split('Published application mailto: ')[1]);
  assert.deepEqual(captured, { recipient: channel.recipient, subject: applicationSubject, body: applicationBody });
  // A reviewed shorter quote may also use the exact decoded subject/mailbox.
  assert.ok(await fetchEmployerEmailPosting(url, { ...mailtoChannel, quote: `"recipient":"${channel.recipient}","subject":"${applicationSubject}"` }, { fetcher: async () => page(mailtoPage(applicationHref)) }));
});

test('mailto capture rejects extra recipients, headers, malformed encoding and unrelated roles', async () => {
  const base = `mailto:${channel.recipient}?subject=${encodeURIComponent(applicationSubject)}`;
  const unsafe = [
    base.replace(channel.recipient, `${channel.recipient},other@employer.com`),
    base.replace(channel.recipient, `${channel.recipient}%2Cother%40employer.com`),
    base.replace(channel.recipient, `${channel.recipient};other@employer.com`),
    base.replace(channel.recipient, `Name%20%3C${channel.recipient}%3E`),
    base.replace(channel.recipient, `${channel.recipient}%0D%0ABcc:other@employer.com`),
    `${base}&cc=other@employer.com`, `${base}&bcc=other@employer.com`, `${base}&to=other@employer.com`,
    `${base}&%62cc=other@employer.com`, `${base}&subject=Another`,
    `${base}%0D%0ABcc%3Aother%40employer.com`, `${base}&body=%00`, `${base}&body=%ZZ`,
    base.replace('Product%20Intern', 'Sales%20Manager'),
    base.replace('Product%20Intern', 'Product%20Internship'),
    base.replace('Product%20Intern', 'Senior%20Product%20Intern'),
    base.replace('Application%20for', 'General%20Inquiry%20about'),
    `${base}#extra`,
  ];
  for (const href of unsafe) {
    // Mailbox-only quote ensures rejection comes from extraction, rather than
    // merely failing to reproduce a longer expected evidence string.
    assert.equal(await fetchEmployerEmailPosting(url, { ...mailtoChannel, quote: channel.recipient }, { fetcher: async () => page(mailtoPage(href)) }), null, href);
  }
});

test('script, comment, template, duplicate href and quoted attribute text do not supply mailto evidence', async () => {
  for (const anchor of [
    `<script>${mailtoPage(applicationHref)}</script>`,
    `<!-- ${mailtoPage(applicationHref)} -->`,
    `<template>${mailtoPage(applicationHref)}</template>`,
    `<a href="${applicationHref}" href="mailto:other@employer.com">Apply</a>`,
    `<a title=' href="${applicationHref}"'>Apply</a>`,
  ]) {
    assert.equal(await fetchEmployerEmailPosting(url, { ...mailtoChannel, quote: channel.recipient }, { fetcher: async () => page(`<h1>Product Intern</h1>${anchor}`) }), null);
  }
});

test('appended evidence remains bound to current quote and total posting cap', async () => {
  for (const body of [mailtoPage(applicationHref.replace('Name%3A', 'Full%20Name%3A')), mailtoPage(applicationHref) + 'x'.repeat(49900)]) {
    assert.equal(await fetchEmployerEmailPosting(url, mailtoChannel, { fetcher: async () => page(body) }), null);
  }
});

const applicationUrl = `${url}/apply/`;
const linkedChannel = {...channel, sourceUrl:applicationUrl};
const linkedJD = `<h1>Product Intern</h1><p>Remote India, current students eligible. Research customers and product strategy.</p><a href="${applicationUrl}">Apply for this role</a>`;
const linkedApplication = `<h1>Apply: Product Intern</h1><noscript><p>The application form needs JavaScript. ${quote}</p></noscript>`;
const linkedFetcher = (jd=linkedJD,application=linkedApplication,calls=[])=>async target=>{calls.push(target);return page(target===url?jd:application);};

test('reviewed linked employer application page preserves full JD and labelled recipient evidence',async()=>{
  const calls=[];
  const result=await fetchEmployerEmailPosting(url,linkedChannel,{fetcher:linkedFetcher(linkedJD,linkedApplication,calls)});
  assert.deepEqual(calls,[url,applicationUrl]);
  assert.equal(result.sourceUrl,url);assert.equal(result.method,'employer-email-page');
  assert.equal(result.text,`Product Intern Remote India, current students eligible. Research customers and product strategy. Apply for this role\nApplication page source: ${applicationUrl}\nApply: Product Intern The application form needs JavaScript. ${quote}`);
});

test('linked application URLs require a real exact anchor on the role page',async()=>{
  const anchor=`<a href="${applicationUrl}">Apply</a>`;
  for(const content of [
    `Apply at ${applicationUrl}`,
    `<script>${anchor}</script>`,
    `<!-- ${anchor} -->`,
    `<template>${anchor}</template>`,
    `<noscript>${anchor}</noscript>`,
    `<a href="${applicationUrl}different">Apply</a>`,
    `<a href="${applicationUrl}#fragment">Apply</a>`,
    `<a href="${applicationUrl}" href="https://other.com/">Apply</a>`,
    `<a title=' href="${applicationUrl}"'>Apply</a>`,
  ]) {
    const calls=[];
    const result=await fetchEmployerEmailPosting(url,linkedChannel,{fetcher:linkedFetcher(`<h1>Product Intern</h1>${content}`,linkedApplication,calls)});
    assert.equal(result,null,content);assert.deepEqual(calls,[url]);
  }
});

test('same-origin relative application anchor resolves to the exact reviewed source URL',async()=>{
  const jd=linkedJD.replace(`href="${applicationUrl}"`,`href="/careers/product-intern/apply/"`);
  assert.ok(await fetchEmployerEmailPosting(url,linkedChannel,{fetcher:linkedFetcher(jd)}));
});

test('linked source must share the exact HTTPS employer origin before any fetch',async()=>{
  for(const sourceUrl of ['https://other.com/apply','http://employer.com/apply','https://jobs.employer.com/apply','https://employer.com:444/apply','https://user:pass@employer.com/apply']) {
    assert.equal(await fetchEmployerEmailPosting(url,{...linkedChannel,sourceUrl},{fetcher:()=>assert.fail('must not fetch')}),null);
  }
});

test('reviewed role must be present on both role page and application page',async()=>{
  for(const [jd,application] of [[linkedJD.replaceAll('Product Intern','Engineer'),linkedApplication],[linkedJD,linkedApplication.replaceAll('Product Intern','Engineer')]]) {
    assert.equal(await fetchEmployerEmailPosting(url,linkedChannel,{fetcher:linkedFetcher(jd,application)}),null);
  }
});

test('recipient and exact quote must occur on the linked application page itself',async()=>{
  for(const application of [linkedApplication.replace(quote,'Apply here'),linkedApplication.replace('careers@employer.com','other@employer.com')]) {
    assert.equal(await fetchEmployerEmailPosting(url,linkedChannel,{fetcher:linkedFetcher(linkedJD+`<p>${quote}</p>`,application)}),null);
  }
});

test('linked application redirects stay same-origin and remain bounded',async()=>{
  let calls=0;
  const same=await fetchEmployerEmailPosting(url,linkedChannel,{fetcher:async target=>{
    calls++;
    if(target===url)return page(linkedJD);
    if(target===applicationUrl)return new Response(null,{status:302,headers:{location:'/careers/application-current'}});
    return page(linkedApplication);
  }});
  assert.ok(same);assert.equal(calls,3);
  for(const location of ['https://other.com/apply','/loop']) {
    calls=0;
    const result=await fetchEmployerEmailPosting(url,linkedChannel,{fetcher:async target=>{
      calls++;return target===url?page(linkedJD):new Response(null,{status:302,headers:{location}});
    }});
    assert.equal(result,null);assert.equal(calls,location.startsWith('https:')?2:4);
  }
});

test('linked pages reject expired/challenged applications and combined text beyond the posting cap',async()=>{
  for(const application of [linkedApplication+'<p>Applications are closed</p>',linkedApplication+'<p>Verify you are human</p>',linkedApplication+'x'.repeat(26000)]) {
    const jd=application.includes('x'.repeat(26000))?linkedJD+'y'.repeat(26000):linkedJD;
    assert.equal(await fetchEmployerEmailPosting(url,linkedChannel,{fetcher:linkedFetcher(jd,application)}),null);
  }
});

test('published Application dash exact-role subject accepts only an optional Remote suffix',async()=>{
  const reviewed={...channel,role:'AI Engineer Intern',quote:channel.recipient};
  for(const subject of ['Application - AI Engineer Intern (Remote)','Application - AI Engineer Intern','Application – AI Engineer Intern','Application – AI Engineer Intern (Remote)']) {
    const href=`mailto:${channel.recipient}?subject=${encodeURIComponent(subject)}`;
    const body=`<h1>AI Engineer Intern</h1><p>Remote India internship.</p><a href="${href}">or email</a>`;
    const result=await fetchEmployerEmailPosting(url,reviewed,{fetcher:async()=>page(body)});
    assert.ok(result,subject);
    assert.ok(result.text.includes(`Published application mailto: ${JSON.stringify({recipient:channel.recipient,subject,body:''})}`));
  }
});

test('dash subject grammar rejects wrong roles, smuggled suffixes, recipients and headers',async()=>{
  const reviewed={...channel,role:'AI Engineer Intern',quote:channel.recipient};
  const valid=`mailto:${channel.recipient}?subject=${encodeURIComponent('Application - AI Engineer Intern (Remote)')}`;
  const badSubjects=['Application - Software Engineer Intern (Remote)','Application - Senior AI Engineer Intern','Application - AI Engineer Internship','Application - AI Engineer Intern (Hybrid)','Application - AI Engineer Intern (Remote India)','Application - AI Engineer Intern (Remote) - referral','Application - AI Engineer Intern (Remote) (Remote)','Application - AI Engineer Intern and Sales Intern','Referral Application - AI Engineer Intern','Apply - AI Engineer Intern','Application - AI Engineer Intern\r\nBcc:other@employer.com'];
  const hrefs=[...badSubjects.map(subject=>`mailto:${channel.recipient}?subject=${encodeURIComponent(subject)}`),valid+'&cc=other@employer.com',valid+'&bcc=other@employer.com',valid+'&%62cc=other@employer.com',valid+'&subject=Other',valid.replace(channel.recipient,channel.recipient+',other@employer.com'),valid.replace(channel.recipient,'other@employer.com'),valid+'&body=%00'];
  for(const href of hrefs) {
    const body=`<h1>AI Engineer Intern</h1><a href="${href}">or email</a>`;
    assert.equal(await fetchEmployerEmailPosting(url,reviewed,{fetcher:async()=>page(body)}),null,href);
  }
});
