import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { authorizeSubmission } from './rollout.mjs';
import { uploadedHash } from './browser.mjs';
import { hash } from './policy.mjs';
import { verifyBundle } from './bundle.mjs';
import { htmlToText } from '../providers/_html-to-text.mjs';

export const MICHMER = Object.freeze({
  source:'https://michmer.in/careers#product-management', page:'https://michmer.in/careers', endpoint:'https://michmer.in/api/apply',
  role:'product-management', roleLabel:'Product Management Intern',
  // Observed by GET on 2026-10-23. Changes require another public contract review.
  scriptHash:'592d6c65ba8615183440b7aab10766d97f06e0948c82d19f137412f05d9588bf',
  acceptedMessage:'Application received. If your profile fits, we will email you from contact@michmer.in.'
});
const sha = value => createHash('sha256').update(value).digest('hex');
const fields=['role','city','name','email','cityOther','links','website','resumeName','t','resume'];
const inputIds=['role','city','cityOther','name','email','links','resume','website'];
export const MICHMER_TIMING_REJECTION_BODY='{"error":"That was submitted too quickly. Please try again."}';
function privateWrite(file,value) { fs.writeFileSync(file,value,{flag:'wx',mode:0o600}); return sha(value); }
function exactPage(value) { try { const u=new URL(value);return u.origin==='https://michmer.in' && u.pathname==='/careers' && !u.search && !u.username && !u.password; } catch { return false; } }
function exactRolePage(value) { return exactPage(value) && ['', '#product-management'].includes(new URL(value).hash); }

export async function inspectMichmerForm(page) {
  if (!exactPage(page.url())) throw new Error('Michmer source channel mismatch');
  const form=page.locator('form#applyForm');
  if (await form.count()!==1) throw new Error('Michmer form missing or ambiguous');
  const script=await page.evaluate(()=>Array.from(document.querySelectorAll('script:not([src])')).map(el=>el.textContent).join('\n'));
  if(sha(script)!==MICHMER.scriptHash)throw new Error('Michmer public submission script changed');
  const shape=await form.evaluate(el=>({ids:Array.from(el.querySelectorAll('input,select,textarea')).map(x=>x.id),required:Array.from(el.querySelectorAll('[required]')).map(x=>x.id),submit:el.querySelector('#submitBtn')?.type,role:el.querySelector('#role option[value="product-management"]')?.textContent}));
  if(JSON.stringify(shape.ids)!==JSON.stringify(inputIds) || JSON.stringify(shape.required)!==JSON.stringify(['role','city','name','email','resume']) || shape.submit!=='submit' || shape.role!==MICHMER.roleLabel)throw new Error('Michmer fields or role changed');
  if(await page.locator('iframe,[class*="captcha"],[id*="captcha"]').count())throw new Error('Michmer CAPTCHA or embedded form requires review');
  return {provider:'michmer',source:MICHMER.source,endpoint:MICHMER.endpoint,scriptHash:sha(script),acceptance:'Exact POST 2xx JSON plus observed employer-specific success state; no public receipt lookup'};
}

export async function prepareMichmerForm(page,profile,resumePath) {
  const contract=await inspectMichmerForm(page);
  const c=profile.candidate||{};
  const candidateCity=profile.location?.city || c.city;
  const citySource=profile.location?.city?'config/profile.yml#location.city':'config/profile.yml#candidate.city';
  // City is not inferred from a free-text region/address or resume narrative.
  if(!c.full_name || !c.email || !candidateCity)throw new Error('Primary profile requires candidate.full_name, candidate.email and explicit location.city or candidate.city');
  if(c.full_name.length>120 || c.email.length>200 || candidateCity.length>60)throw new Error('Primary answer exceeds employer field limits');
  const bytes=fs.readFileSync(resumePath);
  if(bytes.length>5*1048576 || !bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('Michmer requires a PDF up to 5 MB');
  const cities=await page.locator('#city option').evaluateAll(els=>els.map(el=>el.value));
  const city=cities.includes(candidateCity)?candidateCity:'Other';
  const values={role:MICHMER.role,city,name:c.full_name,email:c.email,cityOther:city==='Other'?candidateCity:'',links:[c.portfolio_url,c.linkedin].filter(Boolean).join(' '),website:''};
  if(values.links.length>500)throw new Error('Primary links exceed employer limit');
  await page.locator('#role').selectOption(values.role);await page.locator('#city').selectOption(city);
  for(const name of ['name','email','links'])await page.locator(`#${name}`).fill(values[name]);
  if(city==='Other')await page.locator('#cityOther').fill(values.cityOther);
  if(await page.locator('#website').inputValue())throw new Error('Unexpected hidden field value');
  await page.locator('#resume').setInputFiles(resumePath);
  const fileHash=hash(bytes.toString('base64'));
  if(await uploadedHash(page.locator('#resume'))!==fileHash)throw new Error('Michmer upload content mismatch');
  const prepared={provider:'michmer',contract,values,resumeName:path.basename(resumePath),resumeHash:fileHash,sources:{name:'config/profile.yml#candidate.full_name',email:'config/profile.yml#candidate.email',city:citySource,links:'config/profile.yml#candidate.portfolio_url,candidate.linkedin'},issues:[],answers:[...Object.entries(values).filter(([name])=>name!=='website').map(([name,value])=>({ref:name,label:name,type:['role','city'].includes(name)?'select-one':'text',value,source:name==='role'?'employer exact role':name==='city'||name==='cityOther'?citySource:name==='links'?'config/profile.yml#candidate.portfolio_url,candidate.linkedin':`config/profile.yml#candidate.${name==='name'?'full_name':name}`})),{ref:'resume',label:'Your CV',type:'file',value:path.basename(resumePath),fileHash}],complete:true};
  await verifyMichmerPrepared(page,prepared,resumePath);
  return prepared;
}

export async function verifyMichmerPrepared(page,prepared,resumePath) {
  const contract=await inspectMichmerForm(page);
  if(!prepared.complete || JSON.stringify(contract)!==JSON.stringify(prepared.contract) || prepared.values.role!==MICHMER.role)throw new Error('Michmer preparation contract mismatch');
  for(const [name,value] of Object.entries(prepared.values))if(await page.locator(`#${name}`).inputValue()!==value)throw new Error(`Michmer answer changed: ${name}`);
  if(await page.locator('#resume').evaluate(el=>el.files?.[0]?.name)!==prepared.resumeName || await uploadedHash(page.locator('#resume'))!==prepared.resumeHash || hash(fs.readFileSync(resumePath).toString('base64'))!==prepared.resumeHash)throw new Error('Michmer resume changed');
  if(await page.locator('input:invalid,select:invalid,textarea:invalid').count())throw new Error('Michmer native validation failed');
  const button=page.locator('#applyForm #submitBtn');
  if(await button.count()!==1 || !await button.isEnabled() || !await button.isVisible())throw new Error('Michmer final control unavailable');
  if(await page.locator('#msg.ok').count())throw new Error('Existing employer confirmation requires reconciliation');
}

export async function verifyMichmerRequest({url,method,contentType,body},prepared,resumeBytes,boundaryProof) {
  if(url!==MICHMER.endpoint || method!=='POST' || !/^multipart\/form-data;\s*boundary=/i.test(contentType||''))throw new Error('Michmer request channel changed');
  const data=await new Response(body,{headers:{'content-type':contentType}}).formData();
  if(JSON.stringify([...data.keys()].sort())!==JSON.stringify([...fields].sort()))throw new Error('Michmer request fields changed or duplicated');
  for(const [name,value] of Object.entries(prepared.values))if(data.get(name)!==value)throw new Error(`Michmer POST answer mismatch: ${name}`);
  if(data.get('resumeName')!==prepared.resumeName || !/^\d{13}$/.test(data.get('t')||''))throw new Error('Michmer upload name or native timing field changed');
  const file=data.get('resume');
  if(!file || typeof file.arrayBuffer!=='function' || file.name!==prepared.resumeName)throw new Error('Michmer POST upload identity mismatch');
  const visibleFile=Buffer.from(await file.arrayBuffer());
  // Chromium's protocol omits uploaded file bytes from postDataBuffer. The
  // native FormData is independently verified before original fetch is called.
  if(!visibleFile.equals(resumeBytes) && !(visibleFile.length===0 && boundaryProof?.resumeHash===prepared.resumeHash))throw new Error('Michmer POST upload mismatch');
  return {requestHash:sha(body),contentType,requestBodyIncludesFile:visibleFile.length>0};
}

export function verifyMichmerBoundary(payload,prepared,resumeBytes) {
  if(payload.url!==MICHMER.endpoint || payload.method!=='POST' || JSON.stringify(payload.entries.map(([name])=>name).sort())!==JSON.stringify([...fields].sort()))throw new Error('Michmer native fetch fields changed');
  const data=new Map(payload.entries);
  for(const [name,value] of Object.entries(prepared.values))if(data.get(name)!==value)throw new Error(`Michmer native answer changed: ${name}`);
  if(data.get('resumeName')!==prepared.resumeName || !/^\d{13}$/.test(data.get('t')||''))throw new Error('Michmer native upload identity changed');
  const file=data.get('resume');
  if(!file || file.name!==prepared.resumeName || file.type!=='application/pdf' || !Buffer.from(file.base64||'','base64').equals(resumeBytes))throw new Error('Michmer native PDF bytes changed');
  return {boundaryHash:sha(JSON.stringify(payload)),resumeHash:prepared.resumeHash};
}

export function verifyMichmerResponse({url,status,body,contentType}) {
  if(url!==MICHMER.endpoint || status<200 || status>=300 || !/^application\/json\b/i.test(contentType||''))throw new Error('Michmer has no verified accepted response');
  let data;try{data=JSON.parse(body);}catch{throw new Error('Michmer accepted response is not JSON');}
  if(!data || typeof data!=='object' || Array.isArray(data) || data.error || data.ok===false || data.success===false)throw new Error('Michmer returned rejection or ambiguous JSON');
  // The observed public handler uses res.ok, not an invented success/ID key.
  return {status,responseHash:sha(body),responseContentType:contentType};
}

export async function submitMichmerPrepared(page,{ledger,id,context,prepared,resumePath,bundle}) {
  authorizeSubmission(ledger,id,context.fingerprints,'michmer');
  const job=ledger.job(id);
  if(!exactRolePage(job.url) || job.payload.role!==MICHMER.roleLabel || path.resolve(bundle)!==path.resolve(job.payload.bundle) || path.resolve(resumePath)!==path.resolve(bundle,'resume.pdf'))throw new Error('Michmer job/bundle mismatch');
  if(JSON.stringify(JSON.parse(fs.readFileSync(path.join(bundle,'answers.json'),'utf8')))!==JSON.stringify(prepared))throw new Error('Michmer prepared answers differ from sealed bundle');
  await verifyMichmerPrepared(page,prepared,resumePath);
  fs.mkdirSync(bundle,{recursive:true,mode:0o700});
  let attempt,postCount=0,requestProof,boundaryProof,boundaryCount=0;
  const resumeBytes=fs.readFileSync(resumePath);
  const guard=async route=>{
    const request=route.request();
    if(['GET','HEAD'].includes(request.method()))return route.continue();
    postCount++;
    try {
      if(postCount!==1 || !attempt || ledger.get('paused'))throw new Error('Michmer duplicate, unreserved or paused POST blocked');
      const body=request.postDataBuffer();
      requestProof=await verifyMichmerRequest({url:request.url(),method:request.method(),contentType:request.headers()['content-type'],body},prepared,resumeBytes,boundaryProof);
      privateWrite(path.join(bundle,'michmer-request.bin'),body);
      ledger.event(id,'form-post-evidence',{attempt,...requestProof,source:MICHMER.source});
      await route.continue();
    } catch(error) { await route.abort('blockedbyclient');ledger.event(id,'form-post-blocked',{attempt,reason:error.message}); }
  };
  await page.exposeFunction('__careerOpsMichmerVerify',async payload=>{
    if(++boundaryCount!==1 || !attempt || ledger.get('paused'))throw new Error('Michmer native fetch is duplicate, unreserved or paused');
    boundaryProof=verifyMichmerBoundary(payload,prepared,resumeBytes);
    privateWrite(path.join(bundle,'michmer-boundary.json'),JSON.stringify(payload));
    return true;
  });
  await page.evaluate(endpoint=>{
    const original=window.fetch;
    window.fetch=async function(input,options) {
      const url=new URL(typeof input==='string'?input:input.url,location.href).href;
      if(url===endpoint && options?.method?.toUpperCase()==='POST') {
        if(!(options.body instanceof FormData))throw new Error('Expected native employer FormData');
        const entries=[];
        for(const [name,value] of options.body.entries()) {
          if(typeof value==='string')entries.push([name,value]);
          else {
            const bytes=new Uint8Array(await value.arrayBuffer());let binary='';
            for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
            entries.push([name,{name:value.name,type:value.type,base64:btoa(binary)}]);
          }
        }
        await window.__careerOpsMichmerVerify({url,method:'POST',entries});
      }
      return original.apply(this,arguments);
    };
  },MICHMER.endpoint);
  await page.route('**/*',guard);
  try {
    const state=authorizeSubmission(ledger,id,context.fingerprints,'michmer');
    attempt=ledger.reserve(id,{limit:state.limit,fingerprints:job.payload.fingerprints});
    ledger.update(id,'submitting',{formIntent:{provider:'michmer',attempt,sourceUrl:MICHMER.source,endpoint:MICHMER.endpoint,bundle,preparedHash:sha(JSON.stringify(prepared)),at:new Date().toISOString()}});
    const responsePromise=page.waitForResponse(r=>r.url()===MICHMER.endpoint && r.request().method()==='POST',{timeout:30000});
    // One native submit event; never API-post, JS-submit, retry or bypass timing.
    const [response]=await Promise.all([responsePromise,page.locator('#applyForm #submitBtn').click({timeout:15000})]);
    const body=await response.text();
    privateWrite(path.join(bundle,'michmer-response.txt'),body);
    // Preserve what the provider actually returned before interpreting it.
    privateWrite(path.join(bundle,'michmer-response-metadata.json'),JSON.stringify({version:1,provider:'michmer',jobId:id,attempt,url:response.url(),status:response.status(),contentType:response.headers()['content-type'] || null,responseHash:sha(body),at:new Date().toISOString()},null,2));
    const accepted=verifyMichmerResponse({url:response.url(),status:response.status(),body,contentType:response.headers()['content-type']});
    await page.waitForFunction(expected=>document.querySelector('#applyForm #msg.ok')?.textContent===expected && document.querySelector('#applyForm #submitBtn')?.style.display==='none',MICHMER.acceptedMessage,{timeout:10000});
    if(postCount!==1 || boundaryCount!==1 || !boundaryProof || !requestProof)throw new Error('Michmer POST proof unavailable');
    const screenshot=await page.screenshot({fullPage:true});
    const screenshotHash=privateWrite(path.join(bundle,'michmer-receipt.png'),screenshot);
    const proof={version:1,provider:'michmer',jobId:id,attempt,sourceUrl:MICHMER.source,endpoint:MICHMER.endpoint,preparedHash:sha(JSON.stringify(prepared)),...requestProof,...boundaryProof,...accepted,screenshotHash,at:new Date().toISOString()};
    privateWrite(path.join(bundle,'michmer-accepted.json'),JSON.stringify(proof,null,2));
    const receipt=michmerReceipt(proof,bundle);
    ledger.receipt(id,receipt);return receipt;
  } catch(error) {
    if(attempt)ledger.update(id,'uncertain',{reasons:[`Michmer outcome requires GET-only reconciliation, never retry: ${error.message}`]});
    throw error;
  } finally { await page.unroute('**/*',guard); }
}
function michmerReceipt(proof,bundle) {return {kind:'form-confirmation',provider:'michmer',reference:`michmer:${proof.attempt}:${proof.requestHash}:${proof.responseHash}`,jobId:proof.jobId,sourceUrl:proof.sourceUrl,endpoint:proof.endpoint,evidencePath:path.join(bundle,'michmer-accepted.json'),screenshot:path.join(bundle,'michmer-receipt.png'),at:proof.at};}

export async function reconcileMichmerForm({ledger,id}) {
  const job=ledger.job(id),attempt=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
  if(!job || !attempt || !['submitting','uncertain','confirmed','applied','exception','rejected'].includes(job.state) || job.payload.formIntent?.attempt!==attempt.id || job.payload.formIntent?.provider!=='michmer')throw new Error('Missing exact Michmer durable intent');
  const intent=job.payload.formIntent,bundle=intent.bundle;
  const file=path.join(bundle,'michmer-accepted.json');
  if(!fs.existsSync(file)) {
    const response=path.join(bundle,'michmer-response.txt');
    if(fs.existsSync(response) && fs.readFileSync(response,'utf8')===MICHMER_TIMING_REJECTION_BODY)return reconcileMichmerRejection({ledger,id});
    return {confirmed:false,requiresReview:true,reason:'No durable accepted-response proof. Public GET has no application lookup; never resend.'};
  }
  const proof=JSON.parse(fs.readFileSync(file,'utf8'));
  if(proof.jobId!==id || proof.attempt!==attempt.id || proof.sourceUrl!==MICHMER.source || intent.sourceUrl!==MICHMER.source || proof.endpoint!==MICHMER.endpoint || proof.preparedHash!==intent.preparedHash || sha(fs.readFileSync(path.join(bundle,'michmer-request.bin')))!==proof.requestHash || sha(fs.readFileSync(path.join(bundle,'michmer-response.txt')))!==proof.responseHash || sha(fs.readFileSync(path.join(bundle,'michmer-receipt.png')))!==proof.screenshotHash)throw new Error('Michmer receipt evidence integrity mismatch');
  const prepared=JSON.parse(fs.readFileSync(path.join(bundle,'answers.json'),'utf8'));
  if(sha(JSON.stringify(prepared))!==proof.preparedHash)throw new Error('Michmer sealed answers changed');
  const boundaryPayload=JSON.parse(fs.readFileSync(path.join(bundle,'michmer-boundary.json'),'utf8'));
  const boundaryProof=verifyMichmerBoundary(boundaryPayload,prepared,fs.readFileSync(path.join(bundle,'resume.pdf')));
  if(boundaryProof.boundaryHash!==proof.boundaryHash || boundaryProof.resumeHash!==proof.resumeHash)throw new Error('Michmer native request evidence changed');
  await verifyMichmerRequest({url:proof.endpoint,method:'POST',contentType:proof.contentType,body:fs.readFileSync(path.join(bundle,'michmer-request.bin'))},prepared,fs.readFileSync(path.join(bundle,'resume.pdf')),boundaryProof);
  verifyMichmerResponse({url:proof.endpoint,status:proof.status,body:fs.readFileSync(path.join(bundle,'michmer-response.txt'),'utf8'),contentType:proof.responseContentType});
  const receipt=michmerReceipt(proof,bundle);ledger.receipt(id,receipt);return {confirmed:true,receipt};
}

const rejectionFiles=['manifest.json','answers.json','resume.pdf','michmer-boundary.json','michmer-request.bin','michmer-response.txt','michmer-response-metadata.json','michmer-rejected.json','michmer-accepted.json'];
export function michmerRejectionSnapshot(ledger,id) {
  const job=ledger.job(id),bundle=job?.payload.formIntent?.bundle;
  if(typeof bundle!=='string')throw new Error('Missing Michmer rejection bundle');
  return sha(JSON.stringify({job,attempt:ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id),events:ledger.db.prepare("SELECT kind,detail FROM events WHERE job_id=? AND kind IN ('submission-intent','form-post-evidence') ORDER BY id").all(id),files:rejectionFiles.map(name=>{const file=path.join(bundle,name);return [name,fs.existsSync(file)?sha(fs.readFileSync(file)):null];})}));
}

async function rejectedEvidence(ledger,id) {
  if(!ledger.ownsLock())throw new Error('Michmer rejection reconciliation requires the active runner lock');
  const job=ledger.job(id),attempt=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id),intent=job?.payload.formIntent;
  if(!job || !attempt || !['submitting','uncertain','exception','rejected'].includes(job.state) || !['intent','rejected'].includes(attempt.outcome) || intent?.provider!=='michmer' || intent.attempt!==attempt.id || intent.sourceUrl!==MICHMER.source || intent.endpoint!==MICHMER.endpoint || !exactRolePage(job.url) || job.payload.role!==MICHMER.roleLabel || !Number.isFinite(Date.parse(intent.at)))throw new Error('Missing exact unresolved Michmer rejection intent');
  const bundle=intent.bundle;
  if(typeof bundle!=='string' || path.resolve(bundle)!==path.resolve(job.payload.bundle) || fs.existsSync(path.join(bundle,'michmer-accepted.json')))throw new Error('Michmer rejection bundle mismatch or conflicting acceptance');
  if(!verifyBundle(bundle,job.payload.fingerprints))throw new Error('Michmer rejection sealed bundle integrity mismatch');
  const prepared=JSON.parse(fs.readFileSync(path.join(bundle,'answers.json'),'utf8'));
  if(!prepared.complete || prepared.provider!=='michmer' || prepared.contract?.source!==MICHMER.source || prepared.contract?.endpoint!==MICHMER.endpoint || prepared.contract?.scriptHash!==MICHMER.scriptHash || sha(JSON.stringify(prepared))!==intent.preparedHash)throw new Error('Michmer rejection prepared answers integrity mismatch');
  const intents=ledger.db.prepare("SELECT detail FROM events WHERE job_id=? AND kind='submission-intent'").all(id).map(event=>JSON.parse(event.detail)).filter(event=>event.attempt===attempt.id);
  if(intents.length!==1 || JSON.stringify(intents[0].fingerprints)!==JSON.stringify(job.payload.fingerprints))throw new Error('Michmer immutable submission intent mismatch');
  const posts=ledger.db.prepare("SELECT detail FROM events WHERE job_id=? AND kind='form-post-evidence'").all(id).map(event=>JSON.parse(event.detail)).filter(event=>event.attempt===attempt.id);
  if(posts.length!==1 || posts[0].source!==MICHMER.source)throw new Error('Michmer immutable POST evidence missing or ambiguous');
  const request=fs.readFileSync(path.join(bundle,'michmer-request.bin')),resume=fs.readFileSync(path.join(bundle,'resume.pdf'));
  if(request.length>6*1048576 || resume.length>5*1048576 || hash(resume.toString('base64'))!==prepared.resumeHash || !resume.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('Michmer rejection PDF integrity mismatch');
  if(sha(request)!==posts[0].requestHash)throw new Error('Michmer immutable request hash mismatch');
  const native=JSON.parse(fs.readFileSync(path.join(bundle,'michmer-boundary.json'),'utf8'));
  const boundary=verifyMichmerBoundary(native,prepared,resume);
  const requestProof=await verifyMichmerRequest({url:MICHMER.endpoint,method:'POST',contentType:posts[0].contentType,body:request},prepared,resume,boundary);
  if(requestProof.requestBodyIncludesFile!==posts[0].requestBodyIncludesFile)throw new Error('Michmer recorded request shape mismatch');
  const parsed=await new Response(request,{headers:{'content-type':posts[0].contentType}}).formData(),nativeFields=new Map(native.entries);
  for(const name of fields.filter(name=>name!=='resume'))if(parsed.get(name)!==nativeFields.get(name))throw new Error('Michmer native and recorded request fields differ');
  const body=fs.readFileSync(path.join(bundle,'michmer-response.txt'),'utf8');
  if(body!==MICHMER_TIMING_REJECTION_BODY)throw new Error('Unknown Michmer response is not definitive rejection proof');
  const metadataPath=path.join(bundle,'michmer-response-metadata.json');
  let status=null,responseContentType=null,metadataHash=null;
  if(fs.existsSync(metadataPath)) {
    const bytes=fs.readFileSync(metadataPath),metadata=JSON.parse(bytes.toString('utf8'));
    if(metadata.version!==1 || metadata.provider!=='michmer' || metadata.jobId!==id || metadata.attempt!==attempt.id || metadata.url!==MICHMER.endpoint || !Number.isInteger(metadata.status) || metadata.status<400 || metadata.status>=500 || !/^application\/json\b/i.test(metadata.contentType || '') || metadata.responseHash!==sha(body) || !Number.isFinite(Date.parse(metadata.at)))throw new Error('Michmer rejection response metadata mismatch');
    status=metadata.status;responseContentType=metadata.contentType;metadataHash=sha(bytes);
  }
  return {version:1,provider:'michmer',jobId:id,attempt:attempt.id,sourceUrl:MICHMER.source,endpoint:MICHMER.endpoint,intentHash:sha(JSON.stringify(intent)),preparedHash:intent.preparedHash,...requestProof,...boundary,responseHash:sha(body),status,observedStatus:status===null?'UNKNOWN':String(status),responseContentType,metadataHash,postEvidenceHash:sha(JSON.stringify(posts[0])),reason:'provider-timing-rejection',noRetry:true};
}
function rejectedReceipt(proof,bundle) {
  return {kind:'form-rejected',provider:'michmer',reference:`michmer-rejected:${proof.attempt}:${proof.requestHash}:${proof.responseHash}`,jobId:proof.jobId,sourceUrl:proof.sourceUrl,endpoint:proof.endpoint,evidencePath:path.join(bundle,'michmer-rejected.json'),status:proof.status,observedStatus:proof.observedStatus,reason:proof.reason,noRetry:true,at:proof.at};
}
export async function verifyMichmerRejectedReceipt({ledger,id}) {
  const before=michmerRejectionSnapshot(ledger,id),core=await rejectedEvidence(ledger,id),job=ledger.job(id),attempt=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
  if(attempt.outcome!=='rejected' || !['exception','rejected'].includes(job.state))throw new Error('Michmer rejection is not durably reconciled');
  const proof=JSON.parse(fs.readFileSync(path.join(job.payload.bundle,'michmer-rejected.json'),'utf8'));
  if(Object.entries(core).some(([key,value])=>JSON.stringify(proof[key])!==JSON.stringify(value)) || !Number.isFinite(Date.parse(proof.at)))throw new Error('Michmer durable rejection evidence mismatch');
  const receipt=rejectedReceipt(proof,job.payload.bundle);
  if(JSON.stringify(JSON.parse(attempt.receipt))!==JSON.stringify(receipt) || before!==michmerRejectionSnapshot(ledger,id))throw new Error('Michmer rejected receipt integrity mismatch');
  return {receipt,snapshot:before};
}
export async function reconcileMichmerRejection({ledger,id}) {
  const existing=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
  if(existing?.outcome==='rejected') {
    const verified=await verifyMichmerRejectedReceipt({ledger,id});
    return {confirmed:false,rejected:true,noRetry:true,receipt:verified.receipt};
  }
  const before=michmerRejectionSnapshot(ledger,id),core=await rejectedEvidence(ledger,id);
  if(before!==michmerRejectionSnapshot(ledger,id))throw new Error('Michmer rejection evidence changed during verification');
  const job=ledger.job(id),file=path.join(job.payload.bundle,'michmer-rejected.json');
  let proof;
  if(fs.existsSync(file)) {
    proof=JSON.parse(fs.readFileSync(file,'utf8'));
    if(Object.entries(core).some(([key,value])=>JSON.stringify(proof[key])!==JSON.stringify(value)) || !Number.isFinite(Date.parse(proof.at)))throw new Error('Conflicting durable Michmer rejection proof');
  } else { proof={...core,at:new Date().toISOString()};privateWrite(file,JSON.stringify(proof,null,2)); }
  const receipt=rejectedReceipt(proof,job.payload.bundle);
  ledger.transaction(()=>{
    if(!ledger.ownsLock() || ledger.job(id).state!==job.state || ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id).outcome!=='intent')throw new Error('Michmer attempt changed during rejection reconciliation');
    ledger.db.prepare("UPDATE attempts SET outcome='rejected',receipt=? WHERE job_id=? AND outcome='intent'").run(JSON.stringify(receipt),id);
    const payload={...job.payload,reasons:['Provider definitively rejected this submission. No application recorded; do not retry or resubmit.']};
    ledger.db.prepare("UPDATE jobs SET state='exception',payload=?,updated=? WHERE id=?").run(JSON.stringify(payload),new Date().toISOString(),id);
    ledger.event(id,'form-rejected',{attempt:core.attempt,receipt});
  });
  return {confirmed:false,rejected:true,noRetry:true,receipt};
}

export async function fetchMichmerPosting(url,fetcher=fetch) {
  if(!exactRolePage(url))return null;
  const response=await fetcher(MICHMER.page,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('Michmer employer posting unavailable');
  const html=await response.text();
  if(Buffer.byteLength(html)>1048576)throw new Error('Michmer posting exceeds capture bound');
  const role=html.match(/<details\b[^>]*\bid="product-management"[^>]*>[\s\S]*?<\/details>/i)?.[0];
  if(!role)throw new Error('Exact Michmer role no longer published');
  const footer=html.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/i)?.[0] || '';
  const footerText=htmlToText(footer,{maxChars:4000});
  const text=htmlToText(role,{maxChars:35000})+(footerText?`\n\nEmployer page footer (shared context): ${footerText}`:'');
  if(!text.includes(MICHMER.roleLabel) || text.length<100 || text.length>=40000)throw new Error('Michmer role capture invalid or truncated');
  return {text,sourceUrl:MICHMER.source,url:MICHMER.source};
}
export async function prepareMichmer(page,profile,resumePath,job) {
  if(job && (!exactRolePage(job.url) || job.payload?.role!==MICHMER.roleLabel))throw new Error('Only exact Michmer Product Management Intern is supported');
  return prepareMichmerForm(page,profile,resumePath);
}
export const submitMichmer=submitMichmerPrepared;
