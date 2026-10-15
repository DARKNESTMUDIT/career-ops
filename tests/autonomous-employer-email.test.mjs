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
