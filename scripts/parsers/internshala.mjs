#!/usr/bin/env node
/**
 * Internshala local parser for career-ops.
 *
 * Reads Internshala's own AJAX listing endpoint (the one its category pages call)
 * and prints normalized jobs JSON on stdout. Zero LLM tokens — scan.mjs applies
 * the usual title/location filters to whatever this emits.
 *
 * Usage:
 *   node scripts/parsers/internshala.mjs --categories a,b,c [--pages 2] [--paid-only]
 *
 * Contract: docs/local-parser-cookbook.md (jobs-json-v1)
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ORIGIN = 'https://internshala.com';

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const categories = argValue('--categories', 'work-from-home-internships')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);
const pages = Math.max(1, Number(argValue('--pages', '1')) || 1);
const paidOnly = process.argv.includes('--paid-only');

/**
 * The stipend cell carries one of: a rupee figure ("Rs 5,000 - 8,000 /month"),
 * "Unpaid", or "Performance Based". Only the literal "Unpaid" is a claim that
 * there is no money; "Performance Based" states a structure without an amount,
 * so it is unstated, not unpaid, and survives --paid-only. A missing cell is
 * likewise no claim at all and survives.
 */
function isExplicitlyUnpaid(stipend) {
  return /^unpaid$/i.test(String(stipend || '').trim());
}

/** Strip tags and collapse whitespace; decode the few entities that show up here. */
function text(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Internshala card titles omit the word "internship" ("AI Prompt Engineering"),
 * because every listing on the site is one. career-ops matches on the title
 * string, so the word has to be restored or nothing here would ever match.
 */
function withInternship(title) {
  return /intern/i.test(title) ? title : `${title} Internship`;
}

function parseCards(listHtml, stats) {
  const out = [];
  // Cards are delimited by the per-listing container id; splitting on it is far
  // more stable than trying to balance nested <div>s with a regex.
  const chunks = String(listHtml || '').split('id="individual_internship_').slice(1);
  // Cards present on the page, before any paid/unpaid filtering. Pagination must
  // key off this, not off kept rows: a page where every card is unpaid yields
  // zero rows but is not the end of the listing.
  stats.cardsOnPage = chunks.length;
  for (const chunk of chunks) {
    const href = chunk.match(/href="(\/internship\/detail\/[^"]+)"/)?.[1];
    const rawTitle = chunk.match(
      /<a[^>]*class="[^"]*job-title-href[^"]*"[^>]*>([\s\S]*?)<\/a>/,
    )?.[1];
    if (!href || !rawTitle) continue;

    const stipend = text(chunk.match(/<span[^>]*class=['"]stipend['"][^>]*>([\s\S]*?)<\/span>/)?.[1]);
    if (paidOnly && isExplicitlyUnpaid(stipend)) {
      stats.dropped++;
      continue;
    }

    const title = withInternship(text(rawTitle));
    const company = text(chunk.match(/<p[^>]*class="[^"]*company-name[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1]) || 'Internshala';
    const location =
      text(chunk.match(/<div[^>]*class="[^"]*row-1-item locations[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1]) ||
      'Work from home';

    out.push({ title, url: ORIGIN + href, company, location });
  }
  return out;
}

async function fetchPage(category, page, stats) {
  const url = `${ORIGIN}/internships_ajax/${category}/page-${page}/`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${category} page ${page}`);
  const body = await res.json();
  return parseCards(body.internship_list_html, stats);
}

const jobs = [];
const seen = new Set();
const failures = [];
const stats = { dropped: 0, cardsOnPage: 0 };

for (const category of categories) {
  for (let page = 1; page <= pages; page++) {
    try {
      const rows = await fetchPage(category, page, stats);
      if (stats.cardsOnPage === 0) break; // genuinely past the last page
      for (const row of rows) {
        if (seen.has(row.url)) continue; // same listing appears in several categories
        seen.add(row.url);
        jobs.push(row);
      }
    } catch (err) {
      failures.push(`${category} p${page}: ${err.message}`);
    }
  }
}

// Every category failing means the endpoint moved or we are being blocked —
// exit non-zero so scan.mjs records a parser failure instead of a silent zero.
if (jobs.length === 0 && failures.length > 0) {
  console.error(`internshala parser failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
if (failures.length > 0) console.error(`internshala parser partial: ${failures.join('; ')}`);
if (paidOnly) console.error(`internshala: dropped ${stats.dropped} explicitly-unpaid listing(s)`);

process.stdout.write(JSON.stringify({ jobs }));
