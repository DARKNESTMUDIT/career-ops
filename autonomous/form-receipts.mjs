import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Public hosted forms are distinct from the employer-authenticated Postings API.
// https://github.com/lever/postings-api#apply-to-a-job-posting documents an
// applicationId for the latter only. Never infer that contract for hosted HTML.
export function leverJobIdentity(value) {
  try {
    const u = new URL(value);
    const match = /^\/([a-zA-Z0-9_-]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/apply)?\/?$/.exec(u.pathname);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !/^jobs(?:\.eu)?\.lever\.co$/.test(u.hostname) || !match) return null;
    return { provider:'lever', origin:u.origin, site:match[1], postingId:match[2], sourceUrl:`${u.origin}/${match[1]}/${match[2]}`, formUrl:`${u.origin}/${match[1]}/${match[2]}/apply` };
  } catch { return null; }
}

export async function inspectLeverForm(page, sourceUrl) {
  const identity = leverJobIdentity(sourceUrl), current = leverJobIdentity(page.url());
  if (!identity || !current || current.sourceUrl !== identity.sourceUrl || new URL(page.url()).pathname.replace(/\/$/,'') !== new URL(identity.formUrl).pathname) throw new Error('Lever posting/form identity mismatch');
  const forms = page.locator('form#application-form');
  if (await forms.count() !== 1) throw new Error('Lever hosted form missing or ambiguous');
  const contract = await forms.evaluate(form => ({ method:form.method.toUpperCase(), action:form.action, encoding:form.enctype,
    submitCount:form.querySelectorAll('#btn-submit').length,
    submitType:form.querySelector('#btn-submit')?.type,
    captchaPresent:!!form.querySelector('[name="h-captcha-response"]'),
    captchaReady:!!form.querySelector('[name="h-captcha-response"]')?.value }));
  const action = new URL(contract.action);
  if (contract.method !== 'POST' || contract.encoding !== 'multipart/form-data' || action.origin !== identity.origin || action.pathname !== new URL(identity.formUrl).pathname || action.search || action.hash || contract.submitCount !== 1 || !['button','submit'].includes(contract.submitType)) throw new Error('Lever hosted submission contract changed');
  return { ...identity, method:contract.method, encoding:contract.encoding, captchaPresent:contract.captchaPresent, captchaReady:contract.captchaReady, receiptCertified:false };
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function privateWrite(file, bytes) { fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'}); return {path:file,sha256:digest(bytes)}; }

// Evidence is useful even when a provider cannot expose a unique receipt. Such
// evidence must never itself turn an application into Applied.
export async function captureFormEvidence(page, {directory, jobId, sourceUrl, purpose='observation'}) {
  const identity = leverJobIdentity(sourceUrl);
  if (!identity || leverJobIdentity(page.url())?.sourceUrl !== identity.sourceUrl) throw new Error('Evidence belongs to a different posting');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const stem = `${purpose}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const imagePath = path.join(directory,`${stem}.png`);
  const screenshot = await page.screenshot({fullPage:true});
  const image = privateWrite(imagePath,screenshot);
  const body = await page.locator('body').innerText();
  const evidence = {version:1,provider:'lever',jobId,...identity,purpose,url:page.url(),at:new Date().toISOString(),screenshot:image,
    body:privateWrite(path.join(directory,`${stem}.txt`),body),
    accepted:false,reason:'Hosted acceptance response and unique receipt have not been certified; page text alone is not submission evidence'};
  const file = path.join(directory,`${stem}.json`); privateWrite(file,JSON.stringify(evidence,null,2));
  return {...evidence,evidencePath:file};
}

// Reconciliation may observe only. GETting a public thank-you URL, a 200 status,
// a still-live job or a matching candidate email cannot prove an application.
// No click, fill, POST, automatic retry, or ledger.receipt is allowed here.
export async function reconcileForm({page,ledger,id,directory}) {
  const job = ledger.job(id);
  const attempt = ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
  if (!job || !attempt || !['submitting','uncertain','confirmed','applied'].includes(job.state)) throw new Error('No durable form intent to reconcile');
  const identity = leverJobIdentity(job.url);
  if (!identity) throw new Error('Unsupported form reconciliation provider');
  if (job.payload.formIntent?.sourceUrl !== identity.sourceUrl || job.payload.formIntent?.attempt !== attempt.id) throw new Error('Missing or mismatched durable form intent');
  // A fresh context prevents background service workers or persisted form state
  // from replaying a submission; intercept every request before navigation.
  const context = await page.context().browser().newContext({serviceWorkers:'block'});
  try {
    await context.route('**/*',route => ['GET','HEAD'].includes(route.request().method()) ? route.continue() : route.abort('blockedbyclient'));
    const observation = await context.newPage();
    await observation.goto(identity.formUrl,{waitUntil:'domcontentloaded',timeout:30000});
    const evidence = await captureFormEvidence(observation,{directory,jobId:id,sourceUrl:job.url,purpose:'reconciliation'});
    ledger.event(id,'form-reconciliation-observation',{evidencePath:evidence.evidencePath,accepted:false});
    return {confirmed:false,requiresReview:true,evidence};
  } finally { await context.close(); }
}
