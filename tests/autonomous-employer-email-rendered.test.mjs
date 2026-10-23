import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fetchEmployerEmailPosting } from '../autonomous/employer-email.mjs';
import { captureRenderedRoleCard, extractRoleCard } from '../autonomous/employer-email-browser.mjs';

const url = 'https://employer.com/career';
const applicationHref = 'mailto:jobs@employer.com?subject=Application%20for%20Product%20Management%20Intern';
const role = 'Product Management Intern';
const quote = '"recipient":"jobs@employer.com","subject":"Application for Product Management Intern"';
const channel = { verified: true, roleUrl: url, sourceUrl: url, employerHost: 'employer.com', role, recipient: 'jobs@employer.com', quote, captureMode: 'rendered-role-card', applicationHref };
const shell = '<html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';
const card = `<section><h2>${role}</h2><p>Research users and write product requirements.</p><p>Remote - India</p><p>Part-time, minimum 3-6 months recommended.</p><a href="${applicationHref}">Apply</a></section>`;
const page = html => new Response(html, { headers: { 'content-type': 'text/html' } });

test('reviewed SPA shell captures only exact role card and labelled employer footer', async () => {
  let calls = 0;
  const result = await fetchEmployerEmailPosting(url, channel, { fetcher: async () => page(shell), renderedCapture: async () => { calls++; return { html: card, footerText: 'Prediscan Technologies' }; } });
  assert.equal(calls, 1);
  assert.match(result.text, /Remote - India/);
  assert.match(result.text, /Published application mailto/);
  assert.match(result.text, /Employer footer identity \(shared page footer\): Prediscan Technologies/);
  assert.doesNotMatch(result.text, /other role/i);
});

test('rendered browser is gated by shell, reviewed metadata, active role and exact application href', async () => {
  const render = () => assert.fail('browser must not launch');
  assert.ok(await fetchEmployerEmailPosting(url, channel, { fetcher: async () => page(`<h1>${role}</h1><a href="${applicationHref}">Apply</a>`), renderedCapture: render }));
  for (const html of [
    '<h1>Verify you are human</h1><div id="root"></div><script src="/x.js"></script>',
    '<h1>This position is closed</h1><div id="root"></div><script src="/x.js"></script>',
    '<h1>Engineering Intern</h1><p>Long full posting content.</p>',
  ]) assert.equal(await fetchEmployerEmailPosting(url, channel, { fetcher: async () => page(html), renderedCapture: render }), null);
  for (const change of [{ verified: false }, { sourceUrl: 'https://other.com/career' }, { applicationHref: 'mailto:other@employer.com' }, { captureMode: 'other' }]) {
    assert.equal(await fetchEmployerEmailPosting(url, { ...channel, ...change }, { fetcher: async () => page(shell), renderedCapture: render }), null);
  }
  assert.equal(await fetchEmployerEmailPosting(url, channel, { fetcher: async () => page(shell), renderedCapture: async () => ({ html: card.replace(applicationHref, 'mailto:other@employer.com') }) }), null);
});

test('card extractor rejects ambiguous roles and excludes adjacent cards', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<main>${card}<section><h2>Software Intern</h2><p>Unrelated degree requirement and compensation.</p><a href="mailto:other@employer.com">Apply</a></section></main><footer>Prediscan Technologies</footer>`);
    const result = await page.evaluate(extractRoleCard, { role, applicationHref });
    assert.match(result.html, /Research users/);
    assert.doesNotMatch(result.html, /Unrelated degree/);
    assert.equal(result.footerText, 'Prediscan Technologies');
    await page.setContent(`<main>${card}${card}</main>`);
    assert.equal(await page.evaluate(extractRoleCard, { role, applicationHref }), null);
    await page.setContent(`<main><section><h2>${role}</h2><a href="${applicationHref}">Apply</a><a href="mailto:other@employer.com">Other role</a></section></main>`);
    assert.equal(await page.evaluate(extractRoleCard, { role, applicationHref }), null);
  } finally { await browser.close(); }
});

test('rendered capture blocks cross-origin and mutation requests before navigation', async () => {
  let routeHandler;
  const decisions = [];
  const fakeRoute = (requestUrl, method) => ({ request: () => ({ url: () => requestUrl, method: () => method }), continue: async () => decisions.push('continue'), abort: async () => decisions.push('abort') });
  const browserFactory = async () => ({
    newContext: async () => ({ newPage: async () => ({
      route: async (_pattern, handler) => { routeHandler = handler; },
      goto: async () => {
        await routeHandler(fakeRoute(url, 'GET'));
        await routeHandler(fakeRoute('https://other.com/tracker', 'GET'));
        await routeHandler(fakeRoute(url, 'POST'));
        await routeHandler(fakeRoute(url, 'HEAD'));
      },
      waitForFunction: async () => {},
      url: () => url,
      evaluate: async () => ({ html: card, footerText: '' }),
    }) }),
    close: async () => {},
  });
  assert.ok(await captureRenderedRoleCard(url, channel, { browserFactory }));
  assert.deepEqual(decisions, ['continue', 'abort', 'abort', 'continue']);
});
