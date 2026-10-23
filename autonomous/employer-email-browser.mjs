import { chromium } from 'playwright';

const MAX_CARD_HTML = 50000;
const MAX_FOOTER_TEXT = 2000;

export function extractRoleCard({ role, applicationHref, maxCard = 50000, maxFooter = 2000 }) {
  const normalized = value => value?.trim().replace(/\s+/g, ' ').toLowerCase();
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(h => normalized(h.textContent) === normalized(role));
  if (headings.length !== 1) return null;
  const exactLinks = [...document.querySelectorAll('a[href]')].filter(a => a.getAttribute('href') === applicationHref);
  if (exactLinks.length !== 1) return null;
  let card = headings[0];
  while (card && !card.contains(exactLinks[0])) card = card.parentElement;
  if (!card || card === document.body || card === document.documentElement) return null;
  const cardHeadings = [...card.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  const cardApplications = [...card.querySelectorAll('a[href^="mailto:"]')];
  if (cardHeadings.length !== 1 || cardApplications.length !== 1 || cardApplications[0] !== exactLinks[0]) return null;
  const html = card.outerHTML;
  if (html.length > maxCard) return null;
  const footer = document.querySelector('footer');
  // The shared footer is useful for employer identity, but its marketing and
  // legal copy must not be mixed into the role's requirements.
  const footerText = footer?.innerText?.trim().split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
  return { html, footerText: footerText.length <= maxFooter ? footerText : '' };
}

// Browser rendering is only a read-only supplement to a locally reviewed,
// exact role/application pair. No page interaction or cross-origin requests.
export async function captureRenderedRoleCard(url, channel, { browserFactory = () => chromium.launch({ headless: true, timeout: 12000 }) } = {}) {
  const target = new URL(url);
  let browser;
  try {
    browser = await browserFactory();
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout?.(8000);
    let requests = 0;
    await page.route('**/*', async route => {
      const request = route.request();
      let allowed = false;
      try {
        const requested = new URL(request.url());
        allowed = ++requests <= 100 && requested.origin === target.origin && ['GET', 'HEAD'].includes(request.method()) && !requested.username && !requested.password;
      } catch { /* Unparseable requests are blocked. */ }
      if (allowed) await route.continue();
      else await route.abort();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
    await page.waitForFunction(role => [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].some(h => h.textContent?.trim().replace(/\s+/g, ' ').toLowerCase() === role.toLowerCase()), channel.role.trim().replace(/\s+/g, ' '), { timeout: 8000 });
    if (page.url() !== url) return null;
    const size = await page.evaluate(() => ({ html: document.documentElement.outerHTML.length, nodes: document.querySelectorAll('*').length }));
    if (size.html > 1024 * 1024 || size.nodes > 5000) return null;
    const result = await page.evaluate(extractRoleCard, { role: channel.role, applicationHref: channel.applicationHref });
    return result;
  } catch { return null; }
  finally { await browser?.close(); }
}
