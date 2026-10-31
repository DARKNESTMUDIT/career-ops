import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {internshipIdentity,intentDigest,inspectInternshalaReceipt} from './internshala-receipts.mjs';
import {installInternshalaNativeBody} from './internshala-native-body.mjs';
import {validateInternshalaNativeArtifacts,inspectInternshalaNativeForm,assertInternshalaScriptAttestation} from './internshala-transport.mjs';

// Unregistered capture component, NOT a submission adapter. It never fills,
// uploads, clicks, reserves an application, updates outcomes or grants credit.
// An integrated caller must already hold a real durable submission intent.
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function responseBytes(response) {
  let timer;
  try {return await Promise.race([response.body(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Provider response body timeout')),20000);})]);}
  finally {clearTimeout(timer);}
}
function durableJSON(file,value) {
  const bytes=Buffer.from(JSON.stringify(value,null,2));
  const fd=fs.openSync(file,'wx',0o600);
  try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  const parent=fs.openSync(path.dirname(file),'r');
  try {fs.fsyncSync(parent);} finally {fs.closeSync(parent);}
  return sha(bytes);
}
function privateFile(file,root) {
  const resolved=fs.realpathSync(file),base=fs.realpathSync(root);
  if(!resolved.startsWith(base+path.sep) || fs.statSync(resolved).mode & 0o077)throw Error('Private application evidence required');
  return resolved;
}

export async function captureInternshalaNativeSubmission(page,{ledger,id,intentFile,sealedIntentSha256,pdfPath,proofDir}) {
  const job=ledger.job(id),attempt=ledger.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(id);
  if(!ledger.ownsLock() || ledger.get('paused') || ledger.get('integrityFailure') || job?.state!=='submitting' || attempt?.outcome!=='intent')throw Error('Active locked submission intent required');
  const intent=JSON.parse(fs.readFileSync(privateFile(intentFile,ledger.dir),'utf8'));
  if(intentDigest(intent)!==sealedIntentSha256 || job.payload.internshalaIntentSha256!==sealedIntentSha256 || intent.durableReference!==attempt.id)throw Error('Durable intent mismatch');
  const initial=inspectInternshalaReceipt({intent,sealedIntentSha256});
  if(initial.reasons.some(reason=>reason!=='missing_har'))throw Error('Incomplete native intent');
  const identity=internshipIdentity(intent.sourceUrl);
  if(!identity || identity.sourceUrl!==job.url || page.url()!==job.url)throw Error('Native source identity mismatch');
  if(intent.nativeForm) {
    // Do not trust a caller's plan as evidence of the live form. Independently
    // check private observed artifacts and the exact current native DOM before
    // capture installation can precede any candidate field or file selection.
    assertInternshalaScriptAttestation(page,intent,ledger.dir);
    validateInternshalaNativeArtifacts(intent,ledger.dir);
    const observed=await inspectInternshalaNativeForm(page,{sourceUrl:intent.sourceUrl});
    if(sha(Buffer.from(observed.outerHTML))!==intent.nativeForm.formArtifact.sha256)throw Error('Live native form differs from sealed observation');
  }
  const pdf=fs.readFileSync(privateFile(pdfPath,ledger.dir));
  if(!pdf.subarray(0,5).equals(Buffer.from('%PDF-')) || sha(pdf)!==intent.pdf?.sha256 || pdf.length!==intent.pdf?.size)throw Error('Frozen PDF mismatch');
  const parent=fs.realpathSync(path.dirname(proofDir));
  if(!parent.startsWith(fs.realpathSync(ledger.dir)+path.sep))throw Error('Proof directory outside application data');
  // mkdir without recursive is an exclusive single-use boundary. Never reopen
  // an earlier capture after crash, lost response or an uncertain outcome.
  fs.mkdirSync(proofDir,{mode:0o700});
  const seal=durableJSON(path.join(proofDir,'capture-intent.json'),{intent,sealedIntentSha256,attempt:attempt.id,ledgerJobId:id});
  ledger.event(id,'internshala-capture-started',{attempt:attempt.id,seal});
  let matchedRequest=null,entry=null,continued=false,stopped=false;
  const failures=[],pending=new Set();
  const persist=(name,value)=>durableJSON(path.join(proofDir,name),value);
  const failed=(where,error)=>{failures.push({where,error:String(error?.message || error)});};
  const routeHandler=async route=>{
    const request=route.request(),method=request.method(),url=request.url();
    if(['GET','HEAD'].includes(method))return route.continue();
    try {
      if(stopped || method!=='POST' || url!==identity.submitUrl || matchedRequest || !ledger.ownsLock() || ledger.get('paused') || ledger.get('integrityFailure') || ledger.job(id)?.state!=='submitting' || intentDigest(JSON.parse(fs.readFileSync(intentFile,'utf8')))!==sealedIntentSha256)throw Error('Unapproved or repeated native mutation');
      const bytes=request.postDataBuffer();
      if(!Buffer.isBuffer(bytes) || bytes.length>12*1024*1024)throw Error('Missing or oversized native request bytes');
      const headers=await request.allHeaders();
      const observed={startedDateTime:new Date().toISOString(),request:{method,url,postData:{mimeType:headers['content-type'],bodyBase64:bytes.toString('base64'),bodySha256:sha(bytes)}},response:{}};
      const check=inspectInternshalaReceipt({intent,sealedIntentSha256,har:{log:{entries:[observed]}}});
      if(!check.requestProven)throw Error('Native request differs from sealed intent: '+check.reasons.join(', '));
      matchedRequest=request;entry=observed;
      const requestHash=persist('request.json',observed);
      ledger.event(id,'internshala-native-request-observed',{attempt:attempt.id,requestHash});
      // The durable proof and ledger event precede the original native request.
      continued=true;
      await route.continue();
    } catch(error) {
      failed('request',error);
      try {persist(`blocked-${randomUUID()}.json`,{method,url,error:error.message,at:new Date().toISOString()});} catch(writeError){failed('blocked-proof',writeError);}
      await route.abort('blockedbyclient');
    }
  };
  const responseHandler=response=>{
    if(response.request()!==matchedRequest || !entry)return;
    const task=(async()=>{
      const metadata={status:response.status(),url:response.url(),observedAt:new Date().toISOString()};
      persist('response-metadata.json',metadata);
      const bytes=await responseBytes(response);
      if(bytes.length>4*1024*1024)throw Error('Oversized provider response');
      const responseProof={...metadata,content:{text:bytes.toString('base64'),encoding:'base64'},bodySha256:sha(bytes)};
      // Raw bytes are saved before any provider JSON interpretation.
      const responseHash=persist('response.json',responseProof);
      entry.response=responseProof;
      ledger.event(id,'internshala-native-response-observed',{attempt:attempt.id,responseHash});
    })().catch(error=>failed('response',error));
    pending.add(task);task.finally(()=>pending.delete(task));
  };
  page.on('response',responseHandler);
  try {
    await page.route('**/*',routeHandler);
    await installInternshalaNativeBody(page,identity.submitUrl);
  } catch(error){page.off('response',responseHandler);await page.unroute('**/*',routeHandler);throw error;}
  return {
    proofDir,
    async stop() {
      if(stopped)throw Error('Capture already stopped');
      stopped=true;
      // After a possible send, retain the deny-mutation route until the caller
      // closes this browser context. Stopping observation cannot unlock retry.
      if(!continued)await page.unroute('**/*',routeHandler);
      page.off('response',responseHandler);
      await Promise.all([...pending]);
      const har={log:{entries:entry?[entry]:[]}};
      const result={attempt:attempt.id,continued,har,failures,receiptCertified:false,requiresExactHistory:true};
      persist('capture.json',result);
      // Leaving submitting/uncertain reconciliation to the integrated caller
      // prevents this recorder from manufacturing a receipt or safe retry.
      return result;
    },
  };
}
