import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import tls from 'node:tls';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {Ledger} from '../autonomous/ledger.mjs';
import {captureInternshalaNativeSubmission} from '../autonomous/internshala-capture.mjs';
import {intentDigest,internshipIdentity} from '../autonomous/internshala-receipts.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');

// Original synthetic fixture. An isolated CONNECT proxy serves every byte;
// the browser cannot reach the real provider. No candidate files/account used.
for(const transport of ['xhr','fetch'])test(`isolated native ${transport} FormData preserves exact PDF bytes before dispatch`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-multipart-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const keyFile=path.join(root,'fixture.key'),certFile=path.join(root,'fixture.crt');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','1','-subj','/CN=internshala.com'],{stdio:'ignore'});
  const source='https://internshala.com/internship/detail/work-from-home-research-internship-at-example1792739586';
  const submit=internshipIdentity(source).submitUrl;
  const pdf=Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.from([0,255,128,13,10]),Buffer.from('\nSynthetic fixture only\n%%EOF')]);
  let serverBody=null;
  const inner=http.createServer((req,res)=>{
    if(req.method==='GET' && req.url===new URL(source).pathname){
      const dispatch=transport==='xhr'?`const xhr=new XMLHttpRequest();xhr.open('POST',${JSON.stringify(submit)},true);xhr.onload=()=>{document.body.dataset.result=xhr.responseText;};xhr.send(new FormData(e.target));`:`const r=await fetch(${JSON.stringify(submit)},{method:'POST',body:new FormData(e.target)});document.body.dataset.result=await r.text();`;
      res.writeHead(200,{'content-type':'text/html'});res.end(`<form id="application-form"><input name="internship_id" value="12345"><input name="answer" value="Synthetic approved answer"><input name="custom_resume" type="file"><button type="submit">Submit fixture</button></form><script>document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();${dispatch}});</script>`);return;}
    if(req.method==='POST' && req.url===new URL(submit).pathname){const parts=[];req.on('data',b=>parts.push(b));req.on('end',()=>{serverBody=Buffer.concat(parts);res.writeHead(200,{'content-type':'application/json'});res.end('{"success":true}');});return;}
    res.writeHead(404);res.end();
  });
  const secure=tls.createServer({key:fs.readFileSync(keyFile),cert:fs.readFileSync(certFile)},sock=>inner.emit('connection',sock));
  const sockets=new Set();
  const proxy=http.createServer((req,res)=>{res.writeHead(403);res.end();});
  proxy.on('connection',sock=>{sockets.add(sock);sock.on('close',()=>sockets.delete(sock));});
  proxy.on('connect',(req,socket,head)=>{if(req.url!=='internshala.com:443'){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)socket.unshift(head);secure.emit('connection',socket);});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const sock of sockets)sock.destroy();proxy.close();secure.close();inner.close();});
  const browser=await chromium.launch({headless:true,proxy:{server:`http://127.0.0.1:${proxy.address().port}`}});
  t.after(()=>browser.close());
  // Fixture certificate only, in a new empty test context, no user browser.
  const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'}),page=await context.newPage();
  await page.goto(source,{waitUntil:'domcontentloaded',timeout:15000});
  const ledger=new Ledger(root),token=ledger.acquire(),id=ledger.add(source);
  t.after(()=>{ledger.release(token);ledger.close();});
  const dir=path.join(ledger.dir,'bundles',id);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const pdfPath=path.join(dir,'resume.pdf');fs.writeFileSync(pdfPath,pdf,{mode:0o600});
  const proofHash=sha('synthetic primary'),intent={sourceUrl:source,state:'active',durableReference:'fixture-attempt',reservedBeforeFirstPII:true,jobId:'12345',jobIdField:'internship_id',company:'Example',role:'Research Intern',approvedSources:['primary'],sourceProofs:{primary:{sha256:proofHash}},fields:{answer:{value:'Synthetic approved answer',source:'primary',sourceSha256:proofHash}},pdf:{fieldName:'custom_resume',filename:'resume.pdf',size:pdf.length,sha256:sha(pdf),frozenBeforeIntent:true}};
  const digest=intentDigest(intent),intentFile=path.join(dir,'intent.json');fs.writeFileSync(intentFile,JSON.stringify(intent),{mode:0o600});
  ledger.update(id,'submitting',{internshalaIntentSha256:digest});ledger.db.prepare('INSERT INTO attempts VALUES (?,?,?,?,NULL)').run('fixture-attempt',id,'2099-01-01','intent');
  const capture=await captureInternshalaNativeSubmission(page,{ledger,id,intentFile,sealedIntentSha256:digest,pdfPath,proofDir:path.join(dir,'native-proof')});
  await page.locator('input[type=file]').setInputFiles(pdfPath);
  const response=page.waitForResponse(r=>r.url()===submit,{timeout:10000}).catch(()=>null);
  await page.getByRole('button',{name:'Submit fixture'}).click();
  const observed=await response;
  const proof=await capture.stop();
  assert.ok(observed,'Native request was blocked: '+JSON.stringify(proof.failures));
  assert.equal(proof.failures.length,0);assert.ok(serverBody?.includes(pdf));
  assert.deepEqual(Buffer.from(proof.har.log.entries[0].request.postData.bodyBase64,'base64'),serverBody);
  assert.equal(proof.receiptCertified,false,'A fixture must never award real application credit');
});
