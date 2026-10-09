#!/usr/bin/env node
// pipeline-view.mjs — clickable browsing view of data/pipeline.md.
//
// pipeline.md stores each row in the machine format the pipeline tooling parses
// (`- [ ] {url} | {company} | {role} | ...`, where cell 0 must stay a BARE url —
// see lineUrl() in reconcile-pipeline.mjs and parsePendingEntries() in
// rank-pipeline.mjs). Rewriting those cells as markdown links would make
// reconcile stop matching processed rows, so this reads the file and renders a
// separate view instead. pipeline.md is never modified.
//
// Usage:
//   node pipeline-view.mjs            # write output/pipeline.html + data/pipeline-view.md
//   node pipeline-view.mjs --open     # ...and open the html in the browser
//   node pipeline-view.mjs --html-only | --md-only
//
// Postings are untrusted external data: every scraped field is HTML-escaped and
// only http(s) urls are turned into links.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = getCareerOpsRoot();
const PIPELINE = join(ROOT, 'data', 'pipeline.md');
const HTML_OUT = join(ROOT, 'output', 'pipeline.html');
const MD_OUT = join(ROOT, 'data', 'pipeline-view.md');

const args = process.argv.slice(2);
const wantOpen = args.includes('--open');
const htmlOnly = args.includes('--html-only');
const mdOnly = args.includes('--md-only');

// ---------- parsing ----------

const URL_RE = /^https?:\/\/\S+$/i;
// Trailing labelled segments scan.mjs and rank-pipeline.mjs append, in any order.
const LABELS = ['posted', 'rank', 'trust', 'note', 'via'];

/**
 * Split one pipeline row into its parts. Returns null for non-rows.
 * Handles both shapes that live in the file:
 *   pending:   `- [ ] {url} | {company} | {role} | {extras...}`
 *   processed: `- [x] [{n}](reports/..) | {url} | {company} | {role} | {extras...}`
 */
export function parseRow(line) {
  const m = /^- \[([ x])\]\s+(.*)$/.exec(line);
  if (!m) return null;
  const done = m[1] === 'x';
  const cells = m[2].split('|').map(c => c.trim()).filter(Boolean);
  const urlAt = cells.findIndex(c => URL_RE.test(c));
  if (urlAt < 0) return null; // no usable link — nothing to click

  const url = cells[urlAt];
  const report = urlAt > 0 ? cells.slice(0, urlAt).join(' ') : '';
  const rest = cells.slice(urlAt + 1);
  const company = rest[0] ?? '';
  const role = rest[1] ?? '';

  const extras = rest.slice(2);
  const labelled = {};
  const plain = [];
  for (const cell of extras) {
    const hit = LABELS.find(l => cell.toLowerCase().startsWith(`${l}:`));
    if (hit) labelled[hit] = cell.slice(hit.length + 1).trim();
    else plain.push(cell);
  }

  return {
    done,
    url,
    report,
    company,
    role,
    location: plain.join(' · '),
    posted: labelled.posted ?? '',
    rank: labelled.rank ?? '',
    note: labelled.note ?? '',
    source: sourceLabel(url),
  };
}

const SOURCES = [
  [/(^|\.)internshala\.com$/i, 'Internshala'],
  [/(^|\.)unstop\.com$/i, 'Unstop'],
  [/(^|\.)lever\.co$/i, 'Lever'],
  [/(^|\.)greenhouse\.io$/i, 'Greenhouse'],
  [/(^|\.)ashbyhq\.com$/i, 'Ashby'],
  [/(^|\.)workday(jobs|)\.com$/i, 'Workday'],
  [/(^|\.)linkedin\.com$/i, 'LinkedIn'],
  [/(^|\.)naukri\.com$/i, 'Naukri'],
  [/(^|\.)wellfound\.com$/i, 'Wellfound'],
];

export function sourceLabel(url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Other'; }
  for (const [re, label] of SOURCES) if (re.test(host)) return label;
  return host;
}

export function parsePipeline(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const row = parseRow(line);
    if (row) rows.push(row);
  }
  return rows;
}

/** Group rows by source, biggest group first, stable inside each group. */
export function groupBySource(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.source)) map.set(r.source, []);
    map.get(r.source).push(r);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

// ---------- rendering ----------

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Markdown link text: neutralise the characters that would break out of [...](...)
const mdText = s => String(s ?? '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();

function renderMarkdown(rows, groups) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const out = [
    '# Pipeline — clickable view',
    '',
    `_Generated ${stamp} from \`data/pipeline.md\` by \`node pipeline-view.mjs\`. Read-only: edit \`data/pipeline.md\`, not this file._`,
    '',
    `**${rows.filter(r => !r.done).length} pending** · ${rows.filter(r => r.done).length} processed · ${groups.length} sources`,
    '',
  ];
  for (const [source, list] of groups) {
    out.push(`## ${source} (${list.length})`, '');
    for (const r of list) {
      const label = mdText(r.role || r.company || r.url);
      const who = mdText(r.company);
      const bits = [r.location, r.posted && `posted ${r.posted}`, r.rank && `rank ${r.rank}`]
        .filter(Boolean).map(mdText);
      const tail = bits.length ? ` — ${bits.join(' · ')}` : '';
      out.push(`- ${r.done ? '~~' : ''}[${label}](${r.url})${r.done ? '~~' : ''}${who ? ` — **${who}**` : ''}${tail}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function renderHtml(rows, groups) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const pending = rows.filter(r => !r.done).length;

  const chips = groups
    .map(([source, list]) => `<button class="chip" data-source="${esc(source)}">${esc(source)} <span>${list.length}</span></button>`)
    .join('');

  const sections = groups.map(([source, list]) => {
    const items = list.map(r => {
      const meta = [
        r.location && `<span class="loc">${esc(r.location)}</span>`,
        r.posted && `<span class="posted">posted ${esc(r.posted)}</span>`,
        r.rank && `<span class="rank">${esc(r.rank)}</span>`,
        r.note && `<span class="note">${esc(r.note)}</span>`,
      ].filter(Boolean).join('');
      const hay = esc(`${r.role} ${r.company} ${r.location} ${r.source}`.toLowerCase());
      return `<li class="job${r.done ? ' done' : ''}" data-source="${esc(r.source)}" data-hay="${hay}">
  <a class="title" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.role || r.company || r.url)}</a>
  <div class="sub"><span class="co">${esc(r.company)}</span>${meta}</div>
</li>`;
    }).join('\n');
    return `<section class="group" data-source="${esc(source)}">
  <h2>${esc(source)} <span class="count">${list.length}</span></h2>
  <ul>
${items}
  </ul>
</section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pipeline — ${pending} pending</title>
<style>
  :root {
    --bg: #fbfaf8; --panel: #fff; --ink: #1c1b19; --muted: #6b6862;
    --line: #e6e2db; --accent: #7a4b2a; --chip: #f2eee8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #15140f; --panel: #1d1c17; --ink: #eeece6; --muted: #9b968c;
      --line: #302e27; --accent: #d9a273; --chip: #262420;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  header {
    position: sticky; top: 0; z-index: 5; background: var(--bg);
    border-bottom: 1px solid var(--line); padding: 18px 24px 12px;
  }
  h1 { margin: 0 0 2px; font-size: 19px; letter-spacing: -0.01em; }
  .stamp { color: var(--muted); font-size: 12.5px; margin-bottom: 12px; }
  #q {
    width: 100%; max-width: 460px; padding: 9px 12px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink); font-size: 14px;
  }
  #q:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .chip {
    border: 1px solid var(--line); background: var(--chip); color: var(--ink);
    border-radius: 999px; padding: 4px 11px; font-size: 12.5px; cursor: pointer; font-family: inherit;
  }
  .chip span { color: var(--muted); }
  .chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .chip.on span { color: rgba(255,255,255,.75); }
  main { padding: 8px 24px 64px; }
  .group h2 {
    font-size: 13px; text-transform: uppercase; letter-spacing: .07em;
    color: var(--muted); margin: 26px 0 8px; font-weight: 600;
  }
  .group h2 .count { font-weight: 400; opacity: .7; }
  ul { list-style: none; margin: 0; padding: 0; }
  .job {
    border-bottom: 1px solid var(--line); padding: 9px 2px;
  }
  .job:hover { background: var(--panel); }
  .title { color: var(--ink); text-decoration: none; font-weight: 550; }
  .title:hover { color: var(--accent); text-decoration: underline; }
  .done .title { text-decoration: line-through; color: var(--muted); }
  .sub { color: var(--muted); font-size: 12.5px; margin-top: 2px; display: flex; flex-wrap: wrap; gap: 10px; }
  .co { color: var(--ink); opacity: .8; }
  .rank { color: var(--accent); }
  .hide { display: none !important; }
  #empty { color: var(--muted); padding: 40px 0; display: none; }
</style>
</head>
<body>
<header>
  <h1>Pipeline — <span id="shown">${pending}</span> shown</h1>
  <div class="stamp">Generated ${esc(stamp)} from data/pipeline.md · click any role to open the posting</div>
  <input id="q" type="search" placeholder="Filter by role, company, location…" autocomplete="off">
  <div class="chips" id="chips"><button class="chip on" data-source="*">All <span>${rows.length}</span></button>${chips}</div>
</header>
<main>
${sections}
  <p id="empty">No postings match that filter.</p>
</main>
<script>
  var jobs = Array.prototype.slice.call(document.querySelectorAll('.job'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.group'));
  var q = document.getElementById('q');
  var shown = document.getElementById('shown');
  var empty = document.getElementById('empty');
  var source = '*';

  function apply() {
    var term = q.value.trim().toLowerCase();
    var n = 0;
    jobs.forEach(function (job) {
      var ok = (source === '*' || job.dataset.source === source) &&
               (!term || job.dataset.hay.indexOf(term) !== -1);
      job.classList.toggle('hide', !ok);
      if (ok) n++;
    });
    groups.forEach(function (g) {
      var any = g.querySelector('.job:not(.hide)');
      g.classList.toggle('hide', !any);
    });
    shown.textContent = n;
    empty.style.display = n ? 'none' : 'block';
  }

  q.addEventListener('input', apply);
  document.getElementById('chips').addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    source = chip.dataset.source;
    Array.prototype.forEach.call(this.querySelectorAll('.chip'), function (c) {
      c.classList.toggle('on', c === chip);
    });
    apply();
  });
  apply();
</script>
</body>
</html>
`;
}

// ---------- main ----------

function main() {
  if (!existsSync(PIPELINE)) {
    console.error(`Not found: ${PIPELINE}`);
    process.exit(1);
  }
  const rows = parsePipeline(readFileSync(PIPELINE, 'utf-8'));
  if (!rows.length) {
    console.log('No linkable rows in data/pipeline.md — nothing to render.');
    return;
  }
  const groups = groupBySource(rows);

  if (!mdOnly) {
    mkdirSync(dirname(HTML_OUT), { recursive: true });
    writeFileSync(HTML_OUT, renderHtml(rows, groups), 'utf-8');
    console.log(`  output/pipeline.html      ${rows.length} postings, ${groups.length} sources`);
  }
  if (!htmlOnly) {
    writeFileSync(MD_OUT, renderMarkdown(rows, groups), 'utf-8');
    console.log(`  data/pipeline-view.md     same list, clickable in any markdown preview`);
  }

  if (wantOpen && !mdOnly) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(opener, [HTML_OUT], { detached: true, stdio: 'ignore' }).unref();
  }
}

// Shared guard also handles a symlinked checkout and paths containing spaces.
if (isMainModule(import.meta.url)) main();
