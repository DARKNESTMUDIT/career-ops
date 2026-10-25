import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { hash, validateClaims } from './policy.mjs';
import { remoteRequirementDisclosure, studentStatusDisclosure, indiaLocationDisclosure } from './availability.mjs';

const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
// Tailor emphasis by ordering bullet points within their original section. Never
// move a claim to a different employer or rewrite a number, title, or scope.
export function tailoredResume(context, job) {
  const text = context.sources['cv.md'].replace(/<!--[\s\S]*?-->/g, '');
  const terms = new Set((`${job.role} ${job.jd}`.toLowerCase().match(/[a-z]{4,}/g) || []));
  const lines = text.split('\n');
  const relevance = line => [...new Set(line.toLowerCase().match(/[a-z]{4,}/g) || [])].filter(t => terms.has(t)).length;
  for (let i = 0; i < lines.length; i++) {
    if (!/^[-*] /.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && /^[-*] /.test(lines[end])) end++;
    lines.splice(i, end - i, ...lines.slice(i, end).sort((a,b) => relevance(b) - relevance(a)));
    i = end - 1;
  }
  const claims = lines.filter(l => l.trim()).map(text => ({ text, quote: text, source: 'cv.md' }));
  validateClaims(claims, context.sources);
  let body = claims.map(({text}) => {
    const heading = text.match(/^(#{1,3}) (.*)$/);
    if (heading) return `<h${heading[1].length}>${escape(heading[2])}</h${heading[1].length}>`;
    return `<p>${escape(text.replaceAll('**','').replace(/^[-*] /,'• '))}</p>`;
  }).join('\n');
  const remoteRequirement=remoteRequirementDisclosure(context,job);
  if (remoteRequirement) body+=`\n<h2>Work arrangement requirement</h2><p>${escape(remoteRequirement)}</p>`;
  const studentStatus=studentStatusDisclosure(context,job);
  if (studentStatus) body+=`\n<h2>Current student status</h2><p>${escape(studentStatus)}</p>`;
  const indiaLocation=indiaLocationDisclosure(context,job);
  if (indiaLocation) body+=`\n<h2>Application location</h2><p>${escape(indiaLocation)}</p>`;
  return { claims, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Resume</title><style>@page{size:A4;margin:15mm}body{font:10pt Arial,sans-serif;line-height:1.25;color:#111}h1{font-size:21pt;margin:0 0 7px}h2{font-size:12.5pt;margin:11px 0 5px;border-bottom:1px solid #ccc;break-after:avoid}h3{font-size:10.5pt;margin:8px 0 4px;break-after:avoid}p{margin:3px 0;orphans:2;widows:2}</style></head><body>${body}</body></html>` };
}

export async function renderPDF(html, destination) {
  const browser = await chromium.launch({ headless:true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent(html, { waitUntil:'load' });
    await page.pdf({ path:destination, format:'A4', printBackground:true });
    fs.chmodSync(destination, 0o600);
  } finally { await browser.close(); }
}

export async function createBundle(context, job, dir, pdfRenderer = renderPDF) {
  fs.mkdirSync(dir, { recursive:true, mode:0o700 });
  const { claims, html } = tailoredResume(context, job);
  const files = { 'jd.txt':job.jd, 'resume.html':html, 'claims.json':JSON.stringify(claims,null,2), 'decision.json':JSON.stringify({ ...job, policy:context.policy },null,2) };
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir,name), value, {mode:0o600});
  await pdfRenderer(html, path.join(dir,'resume.pdf'));
  const pdf = fs.readFileSync(path.join(dir,'resume.pdf'));
  if (!pdf.subarray(0,5).equals(Buffer.from('%PDF-')) || pdf.length < 500) throw new Error('Invalid generated resume PDF');
  return { dir, resumePath:path.join(dir,'resume.pdf'), claims };
}

export function sealBundle(dir, job, prepared) {
  if (!prepared.complete || prepared.issues.length || !prepared.answers.length) throw new Error('Application fields are incomplete');
  const pdfHash = hash(fs.readFileSync(path.join(dir,'resume.pdf')).toString('base64'));
  if (prepared.resumeHash !== pdfHash || !prepared.answers.some(a => a.type === 'file' && a.fileHash === pdfHash)) throw new Error('Exact resume upload is unverified');
  fs.writeFileSync(path.join(dir,'answers.json'), JSON.stringify(prepared,null,2), {mode:0o600});
  const files = Object.fromEntries(['jd.txt','resume.html','resume.pdf','claims.json','decision.json','answers.json'].map(name => [name,hash(fs.readFileSync(path.join(dir,name)).toString('base64'))]));
  const manifest = { version:1, complete:true, fingerprints:job.fingerprints, track:job.track, url:job.sourceUrl, at:new Date().toISOString(), files };
  fs.writeFileSync(path.join(dir,'manifest.json'), JSON.stringify(manifest,null,2), {mode:0o600});
  return manifest;
}

export function sealEmailBundle(dir,job,draft) {
  if(draft.channel?.verified!==true || draft.channel.postingHash!==job.fingerprints.posting)throw new Error('Email channel requires current posting evidence');
  fs.writeFileSync(path.join(dir,'email.json'),JSON.stringify(draft,null,2),{mode:0o600});
  fs.writeFileSync(path.join(dir,'answers.json'),JSON.stringify({complete:true,kind:'email',recipient:draft.to,claims:draft.claims},null,2),{mode:0o600});
  const files=Object.fromEntries(['jd.txt','resume.html','resume.pdf','claims.json','decision.json','answers.json','email.json'].map(name=>[name,hash(fs.readFileSync(path.join(dir,name)).toString('base64'))]));
  const manifest={version:1,kind:'email',complete:true,fingerprints:job.fingerprints,track:job.track,url:job.sourceUrl,at:new Date().toISOString(),files};
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  return manifest;
}

export function verifyBundle(dir, fingerprints) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
    if (m.version !== 1 || m.complete !== true || JSON.stringify(m.fingerprints) !== JSON.stringify(fingerprints)) return false;
    const required = ['jd.txt','resume.html','resume.pdf','claims.json','decision.json','answers.json'];
    if(m.kind==='email')required.push('email.json');
    return required.every(name => typeof m.files?.[name] === 'string' && hash(fs.readFileSync(path.join(dir,name)).toString('base64')) === m.files[name]);
  } catch { return false; }
}
