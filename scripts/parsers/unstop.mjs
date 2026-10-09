#!/usr/bin/env node
/**
 * Unstop local parser for career-ops.
 *
 * Reads Unstop's public opportunity search API and prints normalized jobs JSON
 * on stdout. Zero LLM tokens — scan.mjs applies the usual filters afterwards.
 *
 * Usage:
 *   node scripts/parsers/unstop.mjs --terms strategy,consulting [--pages 2] [--type internships] [--paid-only]
 *
 * Contract: docs/local-parser-cookbook.md (jobs-json-v1)
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ORIGIN = 'https://unstop.com';
const PER_PAGE = 30;

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const terms = argValue('--terms', '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
const pages = Math.max(1, Number(argValue('--pages', '1')) || 1);
const type = argValue('--type', 'internships');
const paidOnly = process.argv.includes('--paid-only');

/**
 * Three states, and only one of them is a drop.
 *
 * Unstop's `jobDetail.paid_unpaid` is authoritative and independent of whether
 * an amount is shown: "paid" with `show_salary: 0` means paid-but-undisclosed,
 * which is NOT the same as unpaid. (The top-level `isPaid` field is unrelated
 * and reads false even on roles paying Rs 25,000/month — do not use it.)
 *
 *   "unpaid"            -> drop under --paid-only
 *   "paid" + range      -> keep
 *   "paid", no range    -> keep (amount not stated)
 *   field missing       -> keep (nothing was claimed either way)
 */
function isExplicitlyUnpaid(item) {
  return String(item?.jobDetail?.paid_unpaid || '').trim().toLowerCase() === 'unpaid';
}

/** Unstop titles usually say "Internship"; restore it when they don't. */
function withInternship(title) {
  return /intern/i.test(title) ? title : `${title} Internship`;
}

/**
 * Location lives in a few different shapes depending on the listing. Anything
 * online-only is reported as "Remote" so it matches the location filter's
 * remote allow-list rather than falling through as an empty string.
 */
function locationOf(item) {
  const parts = [];
  if (Array.isArray(item.locations)) parts.push(...item.locations.map((l) => (typeof l === 'string' ? l : l?.name)));
  if (item.jobDetail?.locations) parts.push(String(item.jobDetail.locations));
  if (item.region) parts.push(String(item.region));
  const joined = parts.filter(Boolean).join(', ').trim();
  if (!joined) return 'Remote';
  return /^online$/i.test(joined) ? 'Remote' : joined.replace(/\bonline\b/gi, 'Remote');
}

async function fetchPage(term, page) {
  const url =
    `${ORIGIN}/api/public/opportunity/search-result` +
    `?opportunity=${encodeURIComponent(type)}&page=${page}&per_page=${PER_PAGE}&oppstatus=open` +
    (term ? `&searchTerm=${encodeURIComponent(term)}` : '');
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for "${term}" page ${page}`);
  const body = await res.json();
  return Array.isArray(body?.data?.data) ? body.data.data : [];
}

const jobs = [];
const seen = new Set();
const failures = [];
let dropped = 0;

for (const term of terms.length ? terms : ['']) {
  for (let page = 1; page <= pages; page++) {
    try {
      const items = await fetchPage(term, page);
      if (items.length === 0) break;
      for (const item of items) {
        if (paidOnly && isExplicitlyUnpaid(item)) {
          dropped++;
          continue;
        }
        const slug = item.public_url || item.seo_url;
        const title = String(item.title || '').trim();
        if (!slug || !title) continue;
        const url = slug.startsWith('http') ? slug : `${ORIGIN}/${String(slug).replace(/^\/+/, '')}`;
        if (seen.has(url)) continue; // the same listing matches several search terms
        seen.add(url);
        jobs.push({
          title: withInternship(title),
          url,
          company: String(item.organisation?.name || 'Unstop').trim(),
          location: locationOf(item),
        });
      }
    } catch (err) {
      failures.push(`"${term}" p${page}: ${err.message}`);
    }
  }
}

if (jobs.length === 0 && failures.length > 0) {
  console.error(`unstop parser failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
if (failures.length > 0) console.error(`unstop parser partial: ${failures.join('; ')}`);
if (paidOnly) console.error(`unstop: dropped ${dropped} explicitly-unpaid listing(s)`);

process.stdout.write(JSON.stringify({ jobs }));
