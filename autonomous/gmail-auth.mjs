import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hash } from './policy.mjs';

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.readonly'];
export async function keychain(root, operation, value) {
  if (process.platform !== 'darwin') throw new Error('Gmail credentials require macOS Keychain');
  return new Promise((resolve,reject) => {
    const child = spawn('/usr/bin/swift',[fileURLToPath(new URL('./keychain.swift',import.meta.url))],{stdio:['pipe','pipe','pipe']});
    let output=''; const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
    child.stdout.on('data',b=>output+=b); child.stderr.on('data',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(new Error('Keychain helper unavailable'));});
    child.on('close',code=>{clearTimeout(timer); if(code!==0)return reject(new Error('Keychain access failed; unlock Keychain or approve its prompt')); try{resolve(JSON.parse(output));}catch{reject(new Error('Invalid Keychain record'));}});
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify({operation,service:'career-ops.autonomous.gmail',account:hash(fs.realpathSync(root)),value:value ? JSON.stringify(value) : undefined}));
  });
}

export function oauthRequest(client, redirect, email, state, verifier) {
  if (!client?.client_id?.endsWith('.apps.googleusercontent.com') || !client.client_secret) throw new Error('A Google OAuth Desktop app client JSON is required');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:GMAIL_SCOPES.join(' '),access_type:'offline',prompt:'consent',login_hint:email,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  return url.href;
}

async function tokenRequest(params, fetcher=fetch) {
  const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params),signal:AbortSignal.timeout(20000)});
  if(!response.ok) throw new Error(`Google OAuth failed (${response.status}); reconnect Gmail`);
  const data=await response.json();
  if(!data.access_token)throw new Error('Google returned no access token');
  return data;
}

export async function connectGmail({root,clientPath,email,onAuthorize,store=keychain,fetcher=fetch,timeoutMs=300000}) {
  const parsed=JSON.parse(fs.readFileSync(clientPath,'utf8'));
  const client=parsed.installed;
  if(!client)throw new Error('Choose OAuth client type Desktop app, not Web application');
  const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
  let done;
  const codePromise=new Promise((resolve,reject)=>{done={resolve,reject};});
  const server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://127.0.0.1');
    if(req.method!=='GET'||u.pathname!=='/oauth/callback'){res.writeHead(404).end();return;}
    const supplied=Buffer.from(u.searchParams.get('state')||''); const expected=Buffer.from(state);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(400).end('Invalid OAuth state');return;}
    if(u.searchParams.has('error')||!u.searchParams.get('code')){res.writeHead(400).end('Gmail connection was not authorized.');done.reject(new Error('Gmail authorization declined'));return;}
    res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end('Authorization received. Return to Codex to check connection status. No application has been sent.');
    done.resolve(u.searchParams.get('code'));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const redirect=`http://127.0.0.1:${server.address().port}/oauth/callback`;
  const timer=setTimeout(()=>done.reject(new Error('Gmail sign-in timed out; run connect again')),timeoutMs);
  try {
    await onAuthorize(oauthRequest(client,redirect,email,state,verifier));
    const code=await codePromise;
    const token=await tokenRequest({client_id:client.client_id,client_secret:client.client_secret,code,code_verifier:verifier,redirect_uri:redirect,grant_type:'authorization_code'},fetcher);
    if(!GMAIL_SCOPES.every(s=>(token.scope||'').split(' ').includes(s))||!token.refresh_token)throw new Error('Both requested Gmail scopes and offline access are required');
    const response=await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`Gmail API unavailable (${response.status}); enable Gmail API in the selected project`);
    const account=await response.json();
    if(account.emailAddress?.toLowerCase()!==email.toLowerCase())throw new Error('Connected Gmail does not match the approved sender');
    await store(root,'put',{client_id:client.client_id,client_secret:client.client_secret,refresh_token:token.refresh_token,email:account.emailAddress,scopes:GMAIL_SCOPES});
    return {connected:true,email:account.emailAddress,storage:'macOS Keychain'};
  } finally {clearTimeout(timer);server.closeAllConnections();server.close();}
}

export async function gmailAccess(root,{store=keychain,fetcher=fetch}={}) {
  const record=await store(root,'get');
  if(!record?.refresh_token)throw new Error('Gmail is not connected');
  const token=await tokenRequest({client_id:record.client_id,client_secret:record.client_secret,refresh_token:record.refresh_token,grant_type:'refresh_token'},fetcher);
  return {token:token.access_token,email:record.email};
}
