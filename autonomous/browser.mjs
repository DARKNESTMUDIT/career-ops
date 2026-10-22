import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { hash } from './policy.mjs';
import { authorizeSubmission } from './rollout.mjs';
import { inspectLeverForm } from './form-receipts.mjs';

export function adapterFor(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (u.hostname === 'michmer.in' && u.pathname === '/careers' && !u.search && (!u.hash || u.hash === '#product-management')) return 'michmer';
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
  const candidate = profile.candidate || {};
  let value, source;
  if (/^(?:full |your )?name\s*\*?$/i.test(label)) [value, source] = [candidate.full_name, 'candidate.full_name'];
  else if (/^first name/i.test(label)) [value, source] = [candidate.full_name?.split(' ')[0], 'candidate.full_name'];
  else if (/^last name/i.test(label)) [value, source] = [candidate.full_name?.split(' ').slice(1).join(' '), 'candidate.full_name'];
  else if (/^(?:your |contact )?e-?mail(?: address)?\s*\*?$/i.test(label)) [value, source] = [candidate.email, 'candidate.email'];
  else if (/^(?:your |contact )?(?:phone|mobile)(?: number)?\s*\*?$/i.test(label)) [value, source] = [candidate.phone, 'candidate.phone'];
  else if (/^(?:portfolio|personal website)(?: url)?\s*\*?$/i.test(label)) [value, source] = [candidate.portfolio_url, 'candidate.portfolio_url'];
  else if (/^linkedin(?: profile)?(?: url)?\s*\*?$/i.test(label)) [value, source] = [candidate.linkedin, 'candidate.linkedin'];
  else if (/^(?:current (?:city|location)|location)\s*\*?$/i.test(label)) [value, source] = [candidate.location, 'candidate.location'];
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
  let providerContract;
  if (adapterFor(page.url()) === 'lever') providerContract = await inspectLeverForm(page,page.url());
  const fields = await snapshotFields(page), answers = [], issues = [];
  if (providerContract?.captchaPresent && !providerContract.captchaReady) issues.push('Lever CAPTCHA requires user interaction; never bypassed');
  if (!fields.length) throw new Error('No supported form fields found');
  let uploaded = false;
  for (const field of fields) {
    const loc = page.locator(`[data-co-field="${field.ref}"]`);
    if (field.type === 'file') {
      if (!/resume|cv|curriculum/i.test(field.label)) { if (field.required) issues.push(`Unknown required upload: ${field.label}`); continue; }
      await loc.setInputFiles(resumePath);
      const name = await loc.evaluate(el => el.files?.[0]?.name);
      if (name !== path.basename(resumePath)) throw new Error('Uploaded resume filename mismatch');
      const fileHash = hash(fs.readFileSync(resumePath).toString('base64'));
      if (await uploadedHash(loc) !== fileHash) throw new Error('Uploaded resume content mismatch');
      uploaded = true; answers.push({ ...field, value: name, fileHash }); continue;
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
  if (await page.locator('input:invalid,textarea:invalid,select:invalid').count()) issues.push('Native form validation failed');
  if (page.frames().some(frame => frame !== page.mainFrame() && !/recaptcha|hcaptcha/.test(frame.url()))) issues.push('Embedded form requires a supported frame adapter');
  const submit = page.getByRole('button', {name:/^(submit application|submit|send application)$/i});
  if (await submit.count() !== 1 || !(await submit.isVisible()) || !(await submit.isEnabled())) issues.push('Final submission control unavailable or ambiguous');
  return { ...(providerContract ? {providerContract} : {}), answers, issues, complete: issues.length === 0, resumeHash: hash(fs.readFileSync(resumePath).toString('base64')) };
}

export async function uploadedHash(loc) {
  const data = await loc.evaluate(async el => {
    if (el.files?.length !== 1) return null;
    const bytes = new Uint8Array(await el.files[0].arrayBuffer());
    let binary = '';
    for (let i=0; i<bytes.length; i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
    return btoa(binary);
  });
  return data === null ? null : hash(data);
}

export function sameJobChannel(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    const clean = u => u.pathname.replace(/\/application\/?$|\/apply\/?$|\/$/g,'');
    return !!adapterFor(a) && x.origin === y.origin && clean(x) === clean(y);
  } catch { return false; }
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
  if (!sameJobChannel(page.url(), url)) throw new Error('Unexpected application redirect');
  if (!(await page.locator('input[type="email"]').count())) {
    const apply = page.getByRole('link', { name:/^apply(?: for this job| now)?$/i });
    if (await apply.count() === 1) { const href = await apply.getAttribute('href'); const destination = new URL(href, page.url()).href; if (!sameJobChannel(destination, url)) throw new Error('External apply channel requires verification'); await page.goto(destination, {waitUntil:'domcontentloaded',timeout:30000}); }
    else {
      const button = page.getByRole('button', {name:/^apply(?: for this job| now)?$/i});
      if (await button.count() === 1) {
        const navigationOnly=await button.evaluate(el=>el.getAttribute('type')==='button' && !el.closest('form') && !document.querySelector('input[type="file"],textarea,input[type="email"]'));
        if(!navigationOnly)throw new Error('Apply button may submit; requires an adapter-specific navigation contract');
        await button.click({timeout:15000});
      }
    }
  }
  if (!sameJobChannel(page.url(), url)) throw new Error('Application belongs to a different role');
  return adapter;
}

export async function submitPrepared(page, { ledger, id, context, prepared, resumePath, bundle, limit }) {
  // Every caller, including direct helper users, must pass the rollout gate.
  // Do this before touching the page or reserving an external action.
  authorizeSubmission(ledger, id, context.fingerprints, adapterFor(ledger.job(id)?.url));
  if (!prepared.complete || hash(fs.readFileSync(resumePath).toString('base64')) !== prepared.resumeHash) throw new Error('Unverified or changed resume');
  const job = ledger.job(id);
  if (path.resolve(bundle) !== path.resolve(job.payload.bundle) || path.resolve(resumePath) !== path.resolve(bundle,'resume.pdf')) throw new Error('Submission bundle mismatch');
  const sealed = JSON.parse(fs.readFileSync(path.join(bundle,'answers.json'),'utf8'));
  if (JSON.stringify(sealed) !== JSON.stringify(prepared)) throw new Error('Prepared answers differ from sealed bundle');
  if (!sameJobChannel(page.url(), job.url)) throw new Error('Submission channel mismatch');
  await validatePreparedForm(page, prepared);
  // Recheck every filled value and the exact upload immediately before intent.
  for (const a of prepared.answers) {
    const loc = page.locator(`[data-co-field="${a.ref}"]`);
    const actual = a.type === 'file' ? await loc.evaluate(el => el.files?.[0]?.name) : a.type.startsWith('select') ? await loc.locator('option:checked').textContent() : await loc.inputValue();
    if (actual?.trim() !== a.value.trim()) throw new Error(`Application changed: ${a.label}`);
    if (a.type === 'file' && await uploadedHash(loc) !== a.fileHash) throw new Error('Uploaded resume content changed');
  }
  // A generic thank-you string is not evidence that this job accepted this
  // candidate. The hosted Lever POST/receipt contract is not documented by its
  // employer-key API, and Greenhouse/Ashby have no certified contract here.
  // Keep preparation available, but fail before durable intent or any click.
  throw new Error(`Provider-specific hosted acceptance and GET-only reconciliation validation pending: ${adapterFor(job.url)}`);
}

export async function validatePreparedForm(page, prepared) {
  const fields=await snapshotFields(page);
  for(const field of fields.filter(f=>f.required)) {
    if(!prepared.answers.some(a=>a.ref===field.ref && a.label===field.label && a.type===field.type))throw new Error('Required application fields changed');
  }
  for(const answer of prepared.answers) {
    if(!fields.some(f=>f.ref===answer.ref && f.label===answer.label && f.type===answer.type))throw new Error('Application field identity changed');
  }
  if(await page.locator('input:invalid,textarea:invalid,select:invalid,[role="combobox"][aria-required="true"],[role="checkbox"][aria-required="true"]').count())throw new Error('Application validation changed');
  if(page.frames().some(frame=>frame!==page.mainFrame() && !/recaptcha|hcaptcha/.test(frame.url())))throw new Error('Embedded form requires a supported frame adapter');
}
