import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {getCareerOpsRoot} from '../path-resolver.mjs';
import {loadContext} from './runner.mjs';
import {isMainModule} from '../lib/is-main-module.mjs';

// The normal Chrome extension session cannot export native network bodies.
// Reuse the existing application-browser profile; never copy normal Chrome
// cookies or credentials. This helper only opens and checks the resume page.
export function internshalaSessionLaunchOptions() {
  // Authentication was verified in visible vendor Chrome. Headless checks can
  // show a login page for this same authenticated profile: do not infer logout.
  // Keep ordinary Chrome's OS Keychain rather than Playwright's test keychain.
  return {channel:'chrome',headless:false,acceptDownloads:false,serviceWorkers:'block',chromiumSandbox:true,ignoreDefaultArgs:['--use-mock-keychain','--password-store=basic']};
}

export async function inspectStudentSession(page,email) {
  if(typeof email!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('Primary account email required');
  const url=new URL(page.url());
  if(url.origin!=='https://internshala.com' || !/^\/student\/resume\/?$/.test(url.pathname))return {connected:false};
  if(await page.locator('#resume-container').count()!==1)return {connected:false};
  const text=await page.locator('#resume-container').innerText();
  if(!text.toLowerCase().includes(String(email).toLowerCase()))throw Error('Internshala student account does not match primary profile');
  return {connected:true,accountMatched:true};
}

export async function connectInternshalaSession({root=getCareerOpsRoot(),timeoutMs=900000,onState=()=>{},launch=options=>chromium.launchPersistentContext(options.dir,options.launch)}={}) {
  const context=loadContext(root),dir=path.join(root,'data/autonomous/browser-profile');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const browser=await launch({dir,launch:internshalaSessionLaunchOptions()});
  try {
    const page=browser.pages()[0] || await browser.newPage();
    await page.goto('https://internshala.com/student/resume',{waitUntil:'domcontentloaded',timeout:30000});
    const first=await inspectStudentSession(page,context.profile.candidate.email);
    if(first.connected){onState(first);return first;}
    onState({connected:false,action:'Sign into your existing Internshala student account in the dedicated Google Chrome window. No password or cookies are collected by this helper.'});
    const started=Date.now();
    while(Date.now()-started<timeoutMs) {
      await delay(1000);
      if(page.isClosed())return {connected:false,reason:'window-closed'};
      const state=await inspectStudentSession(page,context.profile.candidate.email);
      if(state.connected){onState(state);return state;}
    }
    return {connected:false,reason:'sign-in-wait-ended'};
  } finally {await browser.close();}
}

if(isMainModule(import.meta.url)) {
  connectInternshalaSession({onState:state=>process.stdout.write(JSON.stringify(state)+'\n')})
    .then(result=>{process.stdout.write(JSON.stringify(result)+'\n');if(!result.connected)process.exitCode=1;})
    .catch(error=>{process.stderr.write(JSON.stringify({error:error.message})+'\n');process.exitCode=1;});
}
