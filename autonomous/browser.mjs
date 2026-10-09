import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { hash } from './policy.mjs';

export function adapterFor(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') return null;
  if (/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(u.hostname)) return 'greenhouse';
  if (/^jobs(?:\.eu)?\.lever\.co$/.test(u.hostname)) return 'lever';
  if (u.hostname === 'jobs.ashbyhq.com') return 'ashby';
  return null;
}
const sensitive = /gender|race|ethnicity|veteran|disability|sexual|religion|demograph/i;
const declaration = /consent|agree|certif|accuracy|privacy|terms|authorization|sponsorship|salary|assessment/i;
export function answerField(field, profile) {
  const label = field.label.trim();
  if (sensitive.test(label)) return { skip: !field.required, reason: 'Sensitive mandatory field requires input' };
  if (declaration.test(label)) return { skip: !field.required, reason: 'Declaration requires an explicit configured answer' };
  const candidate = profile.candidate;
  let value, source;
  if (/^(?:full |your )?name\s*\*?$/i.test(label)) [value, source] = [candidate.full_name, 'candidate.full_name'];
  else if (/^first name/i.test(label)) [value, source] = [candidate.full_name?.split(' ')[0], 'candidate.full_name'];
  else if (/^last name/i.test(label)) [value, source] = [candidate.full_name?.split(' ').slice(1).join(' '), 'candidate.full_name'];
  else if (/e-?mail/i.test(label)) [value, source] = [candidate.email, 'candidate.email'];
  else if (/phone|mobile/i.test(label)) [value, source] = [candidate.phone, 'candidate.phone'];
  else if (/portfolio|personal website/i.test(label)) [value, source] = [candidate.portfolio_url, 'candidate.portfolio_url'];
  else if (/linkedin/i.test(label)) [value, source] = [candidate.linkedin, 'candidate.linkedin'];
  else if (/^current (?:city|location)|^location$/i.test(label)) [value, source] = [candidate.location, 'candidate.location'];
  if (!value) return { skip: !field.required, reason: `Unknown answer: ${label}` };
  if (field.options?.length && !field.options.includes(value)) return { skip: false, reason: `No exact option for ${label}` };
  return { value, source: `config/profile.yml#${source}` };
}

export async function snapshotFields(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('input,textarea,select')).filter(el => !['hidden','submit','button','reset','image'].includes(el.type) && (el.type === 'file' || el.getClientRects().length > 0) && !el.disabled).map((el, i) => {
    const ref = `co-field-${i}`; el.setAttribute('data-co-field', ref);
    const label = Array.from(el.labels || []).map(l => l.innerText).join(' ').trim() || el.getAttribute('aria-label') || el.placeholder || el.name || '';
    return { ref, label, type: el.type || el.tagName.toLowerCase(), required: el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(label), options: el.tagName === 'SELECT' ? Array.from(el.options).map(o=>o.textContent.trim()).filter(Boolean) : null };
  }));
}
export async function prepareForm(page, profile, resumePath) {
  const text = await page.locator('body').innerText();
  if (/verify you are human|captcha challenge|sign in to apply|log in to apply|two.factor authentication/i.test(text)) throw new Error('Login, MFA or CAPTCHA requires interaction');
  const fields = await snapshotFields(page), answers = [], issues = [];
  if (!fields.length) throw new Error('No supported form fields found');
  let uploaded = false;
  for (const field of fields) {
    const loc = page.locator(`[data-co-field="${field.ref}"]`);
    if (field.type === 'file') {
      if (!/resume|cv|curriculum/i.test(field.label)) { if (field.required) issues.push(`Unknown required upload: ${field.label}`); continue; }
      await loc.setInputFiles(resumePath);
      const name = await loc.evaluate(el => el.files?.[0]?.name);
      if (name !== path.basename(resumePath)) throw new Error('Uploaded resume filename mismatch');
      uploaded = true; answers.push({ ...field, value: name, fileHash: hash(fs.readFileSync(resumePath).toString('base64')) }); continue;
    }
    const answer = answerField(field, profile);
    if (answer.skip) continue;
    if (!answer.value || ['checkbox','radio'].includes(field.type)) { issues.push(answer.reason || `Unsupported choice: ${field.label}`); continue; }
    if (field.type.startsWith('select')) await loc.selectOption({label:answer.value}); else await loc.fill(answer.value);
    const actual = field.type.startsWith('select') ? await loc.locator('option:checked').textContent() : await loc.inputValue();
    if (actual?.trim() !== answer.value.trim()) throw new Error(`Field verification failed: ${field.label}`);
    answers.push({ ...field, ...answer });
  }
  if (!uploaded) issues.push('Resume upload not verified');
  // Layout changes, custom comboboxes and multi-page forms fail closed until
  // their fields are supported; no model-selected click can submit a form.
  const customRequired = await page.locator('[role="combobox"][aria-required="true"], [role="checkbox"][aria-required="true"]').count();
  if (customRequired) issues.push('Custom required controls need an adapter');
  return { answers, issues, complete: issues.length === 0, resumeHash: hash(fs.readFileSync(resumePath).toString('base64')) };
}

export async function withApplicationBrowser(root, fn) {
  const dir = path.join(root, 'data/autonomous/browser-profile');
  const context = await chromium.launchPersistentContext(dir, { headless: false, acceptDownloads: false });
  try { const page = context.pages()[0] || await context.newPage(); return await fn(page); }
  finally { await context.close(); }
}

export async function openForm(page, url) {
  const adapter = adapterFor(url); if (!adapter) throw new Error('Unsupported submission adapter');
  await page.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
  if (adapterFor(page.url()) !== adapter) throw new Error('Unexpected application redirect');
  if (!(await page.locator('input[type="email"]').count())) {
    const apply = page.getByRole('link', { name:/^apply(?: for this job| now)?$/i });
    if (await apply.count() === 1) { const href = await apply.getAttribute('href'); const destination = new URL(href, page.url()).href; if (adapterFor(destination) !== adapter) throw new Error('External apply channel requires verification'); await page.goto(destination, {waitUntil:'domcontentloaded'}); }
  }
  return adapter;
}

export async function submitPrepared(page, { ledger, id, context, prepared, resumePath, bundle, limit }) {
  if (!prepared.complete || hash(fs.readFileSync(resumePath).toString('base64')) !== prepared.resumeHash) throw new Error('Unverified or changed resume');
  const job = ledger.job(id);
  if (!adapterFor(page.url()) || adapterFor(page.url()) !== adapterFor(job.url)) throw new Error('Submission channel mismatch');
  // Recheck every filled value and the exact upload immediately before intent.
  for (const a of prepared.answers) {
    const loc = page.locator(`[data-co-field="${a.ref}"]`);
    const actual = a.type === 'file' ? await loc.evaluate(el => el.files?.[0]?.name) : a.type.startsWith('select') ? await loc.locator('option:checked').textContent() : await loc.inputValue();
    if (actual?.trim() !== a.value.trim()) throw new Error(`Application changed: ${a.label}`);
  }
  const before = await page.locator('body').innerText();
  const success = /application (?:has been )?(?:submitted|received)|thank you for applying|thanks for applying/i;
  if (success.test(before)) throw new Error('Existing confirmation requires duplicate reconciliation');
  const button = page.getByRole('button', {name:/^(submit application|submit|send application)$/i});
  if (await button.count() !== 1) throw new Error('Final submit control is ambiguous');
  ledger.reserve(id, {limit, fingerprints:context.fingerprints});
  try {
    if (ledger.get('paused')) throw new Error('Paused after intent; reconcile before retry');
    await button.click({timeout:15000});
    await page.waitForFunction(() => /application (?:has been )?(?:submitted|received)|thank you for applying|thanks for applying/i.test(document.body.innerText), null, {timeout:20000});
    const screenshot = path.join(bundle,'receipt.png'); await page.screenshot({path:screenshot,fullPage:true});
    const receipt = {kind:'form-confirmation',reference:screenshot,url:page.url(),at:new Date().toISOString(),text:(await page.locator('body').innerText()).slice(0,4000)};
    ledger.receipt(id,receipt); return receipt;
  } catch (e) { ledger.update(id,'uncertain',{reasons:[`Submission outcome requires reconciliation: ${e.message}`]}); throw e; }
}
