import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const INTERNSHALA_HISTORY_VERSION='next-history@1';
const origin='https://internshala.com';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const normalize=value=>String(value ?? '').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
const roleIdentity=value=>normalize(value).replace(/\s+(?:intern|internship)$/,'');
const hex=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
// Historical provider slugs include actual consecutive hyphens. This is only
// history identity parsing; the native submission adapter's stricter exact ARH
// source/slug contract is unchanged.
const sourceIdentity=value=>typeof value==='string' && /^https:\/\/internshala\.com\/internship\/detail\/[a-z0-9]+(?:-+[a-z0-9]+)*$/.test(value) ? value:null;
const endpoint=(type,page)=>`${origin}/api/candidate/dashboard/paginated_applications/${type}/${page}?dashboard_source=recent`;
const count=value=>typeof value==='string' && /^(?:0|[1-9]\d*)$/.test(value) && Number(value)<=10000 ? Number(value):null;
const instant=value=>typeof value==='string'?Date.parse(value):NaN;
const base64=value=>{if(typeof value!=='string')return null;const bytes=Buffer.from(value,'base64');return bytes.toString('base64')===value?bytes:null;};

function readResponse(proof) {
  if(proof?.status!==200 || !['new','old'].includes(proof.type) || !Number.isSafeInteger(proof.page) || proof.page<1 || proof.url!==endpoint(proof.type,proof.page) || !['page','stability'].includes(proof.purpose) || !Number.isFinite(instant(proof.observedAt)))throw Error('Incomplete provider history response');
  const bytes=base64(proof.bodyBase64);
  if(!bytes || bytes.length>4*1024*1024 || !hex(proof.bodySha256) || sha(bytes)!==proof.bodySha256 || proof.artifact?.sha256!==proof.bodySha256 || !proof.artifact?.path)throw Error('History response bytes or durable artifact mismatch');
  let data;try{data=JSON.parse(bytes.toString('utf8'));}catch{throw Error('History response is not provider JSON');}
  if(data.success!==true || !Array.isArray(data.applications) || count(data.recent_application_count)===null || count(data.old_application_count)===null)throw Error('Unknown provider history schema');
  const rows=data.applications.map(row=>{
    if(!Number.isSafeInteger(row?.id) || row.id<=0 || typeof row.company_name!=='string' || !row.company_name.trim() || typeof row.profile_to_display!=='string' || !row.profile_to_display.trim() || !sourceIdentity(row.url) || row.application_review_url!==`${origin}/application/view/${row.id}` || typeof row.applied_at!=='string' || !/^\d{1,2} [A-Z][a-z]{2}' \d{2}$/.test(row.applied_at) || typeof row.application_status!=='string')throw Error('Unknown provider application row');
    return row;
  });
  return {data,rows,counts:{new:count(data.recent_application_count),old:count(data.old_application_count)}};
}

function png(bytes) {
  return bytes?.length>=67 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.readUInt32BE(8)===13 && bytes.toString('ascii',12,16)==='IHDR' && bytes.readUInt32BE(16)>0 && bytes.readUInt32BE(20)>0 && bytes.toString('ascii',bytes.length-8,bytes.length-4)==='IEND';
}

// Reconstruct completeness from raw provider responses. A caller-supplied
// complete/absent flag and the provider's unreliable total_pages are ignored.
export function inspectInternshalaHistorySnapshot(snapshot) {
  if(snapshot?.version!==INTERNSHALA_HISTORY_VERSION || !['before','after'].includes(snapshot.phase) || !sourceIdentity(snapshot.sourceUrl) || !Number.isFinite(instant(snapshot.startedAt)) || !Number.isFinite(instant(snapshot.completedAt)) || instant(snapshot.startedAt)>instant(snapshot.completedAt) || !Array.isArray(snapshot.responses) || snapshot.responses.length>202)throw Error('Complete next-history snapshot required');
  const responses=snapshot.responses.map(proof=>({proof,...readResponse(proof)}));
  if(responses.length<4 || responses.some(({proof})=>instant(proof.observedAt)<instant(snapshot.startedAt) || instant(proof.observedAt)>instant(snapshot.completedAt)))throw Error('History response outside snapshot interval');
  const expected=responses[0].counts;
  if(responses.some(item=>item.counts.new!==expected.new || item.counts.old!==expected.old))throw Error('Provider history count drift');
  const all=[],ids=new Set();
  for(const type of ['new','old']) {
    const pages=responses.filter(item=>item.proof.type===type && item.proof.purpose==='page');
    const stability=responses.filter(item=>item.proof.type===type && item.proof.purpose==='stability');
    if(!pages.length || stability.length!==1 || stability[0].proof.page!==1)throw Error('Missing complete history collection or stability read');
    let n=0;
    for(let index=0;index<pages.length;index++) {
      const item=pages[index];
      if(item.proof.page!==index+1 || (index>0 && n>=expected[type]) || (!item.rows.length && n<expected[type]))throw Error('Partial or noncontiguous history pages');
      for(const row of item.rows) {
        if(ids.has(row.id))throw Error('Repeated history application ID');
        ids.add(row.id);all.push({type,page:item.proof.page,row});n++;
      }
    }
    if(n!==expected[type])throw Error('History arrays do not cover reported count');
    const identities=rows=>rows.map(({id,url,company_name,profile_to_display,application_review_url,applied_at})=>({id,url,company_name,profile_to_display,application_review_url,applied_at}));
    if(JSON.stringify(identities(pages[0].rows))!==JSON.stringify(identities(stability[0].rows)) || instant(stability[0].proof.observedAt)<Math.max(...responses.filter(item=>item.proof.purpose==='page').map(item=>instant(item.proof.observedAt))))throw Error('History changed during collection');
  }
  const ui=snapshot.ui;
  const url=ui?new URL(ui.pageUrl):null;
  if(!url || url.origin!==origin || !['/student/applications/','/student/old_applications/'].includes(url.pathname) || url.search!=='?dashboard_source=recent' || typeof ui.pageHtml!=='string' || ui.pageHtml.length>4_000_000 || sha(Buffer.from(ui.pageHtml))!==ui.pageSha256 || ui.pageArtifact?.sha256!==ui.pageSha256 || !ui.pageArtifact?.path || !Number.isFinite(instant(ui.observedAt)) || instant(ui.observedAt)<instant(snapshot.startedAt) || instant(ui.observedAt)>instant(snapshot.completedAt))throw Error('Actual history UI snapshot required');
  const screenshot=base64(ui.screenshotBase64);
  if(!png(screenshot) || sha(screenshot)!==ui.screenshotSha256 || ui.screenshotArtifact?.sha256!==ui.screenshotSha256 || !ui.screenshotArtifact?.path)throw Error('Actual history PNG proof required');
  return {rows:all,counts:expected};
}

export function assertInternshalaHistoryBefore(before,{sourceUrl,company,role}={}) {
  if(before?.phase!=='before' || before.sourceUrl!==sourceUrl || !normalize(company) || !normalize(role))throw Error('Exact provider history baseline required');
  const inspected=inspectInternshalaHistorySnapshot(before);
  if(inspected.rows.some(({row})=>row.url===sourceUrl || normalize(row.company_name)===normalize(company) && roleIdentity(row.profile_to_display)===roleIdentity(role)))throw Error('Existing exact source or historical company-role application; do not resend');
  return {verified:true,version:INTERNSHALA_HISTORY_VERSION,rows:inspected.rows.length,completedAt:before.completedAt};
}

export function internshalaHistoryDigest(snapshot) {
  inspectInternshalaHistorySnapshot(snapshot);
  // Same exact JSON serialization convention as the sealed native intent.
  // Includes source identity, every original response byte, UI and PNG proof.
  return sha(Buffer.from(JSON.stringify(snapshot)));
}

function text(html) {return html.replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&#39;|&apos;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();}
function anchors(html) {return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(match=>({href:/\bhref\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1]?.replace(/&amp;/g,'&'),text:text(match[2])}));}
function providerDate(at) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',year:'2-digit'}).formatToParts(new Date(at)).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  return `${Number(parts.day)} ${parts.month}' ${parts.year}`;
}

// The receipt module calls this only after raw native request and provider
// success are proven. This function itself never grants ledger/tracker credit.
export function verifyNextReceipt(before,after,intent,entry) {
  try {
    assertInternshalaHistoryBefore(before,intent);
    if(!hex(intent.historyBeforeSha256) || internshalaHistoryDigest(before)!==intent.historyBeforeSha256)return null;
    if(after?.phase!=='after' || after.sourceUrl!==intent.sourceUrl || !(instant(before.completedAt)<instant(entry.startedDateTime) && instant(entry.startedDateTime)<instant(after.startedAt)))return null;
    const prior=inspectInternshalaHistorySnapshot(before),later=inspectInternshalaHistorySnapshot(after);
    const previousIds=new Set(prior.rows.map(({row})=>row.id));
    if(prior.rows.some(({row})=>!later.rows.some(item=>item.row.id===row.id)))return null;
    const matches=later.rows.filter(({row})=>row.url===intent.sourceUrl);
    if(matches.length!==1)return null;
    const row=matches[0].row;
    if(previousIds.has(row.id) || normalize(row.company_name)!==normalize(intent.company) || normalize(row.profile_to_display)!==normalize(intent.role) || row.applied_at!==providerDate(entry.startedDateTime))return null;
    const ui=after.ui,card=ui.card;
    if(!card || card.visible!==true || typeof card.outerHTML!=='string' || card.outerHTML.length>100_000 || sha(Buffer.from(card.outerHTML))!==card.sha256 || ui.pageHtml.split(card.outerHTML).length!==2)return null;
    const root=/^<div\b[^>]*\bclass="([^"]*)"[^>]*>/i.exec(card.outerHTML),classes=root?.[1].split(/\s+/) ?? [];
    // Actual observed closest row container, not a table/body combining rows.
    if(!['flex','flex-row','items-center','text-sm','lg:hidden'].every(name=>classes.includes(name)))return null;
    const links=anchors(card.outerHTML),sources=links.filter(link=>sourceIdentity(link.href)),views=links.filter(link=>/^https:\/\/internshala\.com\/application\/view\/\d+(?:\?referral=dashboard)?$/.test(link.href ?? ''));
    if(sources.length!==1 || sources[0].href!==row.url || !views.length || new Set(views.map(link=>link.href.replace(/\?.*/,''))).size!==1 || views.some(link=>link.href.replace(/\?.*/,'')!==row.application_review_url))return null;
    if(normalize(sources[0].text)!==normalize(`${row.profile_to_display} Internship ${row.company_name}`))return null;
    const content=normalize(text(card.outerHTML));
    if(!content.includes(normalize(row.company_name)) || !content.includes(normalize(row.profile_to_display)) || !content.includes(normalize(`Applied on ${row.applied_at}`)))return null;
    return {applicationId:String(row.id),sourceUrl:intent.sourceUrl,historyVersion:INTERNSHALA_HISTORY_VERSION,cardSha256:card.sha256,screenshotSha256:ui.screenshotSha256,historySha256:sha(Buffer.from(JSON.stringify({before,after})))};
  } catch {return null;}
}

function save(file,bytes) {
  const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  return {path:file,sha256:sha(bytes)};
}

async function allowedUiRead(route) {
  const req=route.request();
  try {
    const url=new URL(req.url());
    if(['GET','HEAD'].includes(req.method()) && url.origin===origin)return route.continue();
    if(req.method()!=='POST' || url.origin!==origin || !/^\/api\/candidate\/dashboard\/paginated_applications\/(?:new|old)\/[1-9]\d*$/.test(url.pathname) || url.search!=='?dashboard_source=recent')return route.abort('blockedbyclient');
    const body=req.postDataBuffer();if(!body || body.length>4096)return route.abort('blockedbyclient');
    const headers=await req.allHeaders(),fields=[...await new Response(body,{headers:{'content-type':headers['content-type']}}).formData()];
    if(fields.length!==1 || fields[0][0]!=='is_node_request' || fields[0][1]!=='1')return route.abort('blockedbyclient');
    return route.continue();
  } catch {return route.abort('blockedbyclient');}
}

// Same authenticated context request jar; no cookie/header export. All API
// calls are the observed read-only history endpoint, sequential and bounded.
export function createInternshalaHistorySnapshot({directory,root,maxPages=100,timeoutMs=20000}={}) {
  const base=fs.realpathSync(root),parent=fs.realpathSync(path.dirname(directory));
  if(!parent.startsWith(base+path.sep) && parent!==base)throw Error('Private history directory required');
  fs.mkdirSync(directory,{mode:0o700});
  if(!Number.isSafeInteger(maxPages) || maxPages<1 || maxPages>100 || !Number.isSafeInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>30000)throw Error('Bounded provider history limits required');
  return async function historySnapshot({phase,page,sourceUrl,before}={}) {
    if(!['before','after'].includes(phase) || !sourceIdentity(sourceUrl) || phase==='after' && (!before || before.sourceUrl!==sourceUrl))throw Error('Exact history phase and source required');
    const dir=path.join(directory,`${phase}-${randomUUID()}`);fs.mkdirSync(dir,{mode:0o700});
    const snapshot={version:INTERNSHALA_HISTORY_VERSION,phase,sourceUrl,startedAt:new Date().toISOString(),responses:[]};
    const context=page.context();let expectedCounts=null;
    async function read(type,n,purpose) {
      const url=endpoint(type,n),response=await context.request.post(url,{multipart:{is_node_request:'1'},headers:{'X-Auth-Token-Is':'1','X-FRONTEND-REQUEST':'1'},timeout:timeoutMs,maxRedirects:0});
      const bytes=await response.body();
      const proof={type,page:n,purpose,url,status:response.status(),observedAt:new Date().toISOString(),bodyBase64:bytes.toString('base64'),bodySha256:sha(bytes),artifact:save(path.join(dir,`${type}-${n}-${purpose}.json`),bytes)};
      snapshot.responses.push(proof);const decoded=readResponse(proof);
      if(expectedCounts && (decoded.counts.new!==expectedCounts.new || decoded.counts.old!==expectedCounts.old))throw Error('Provider history count drift');
      expectedCounts??=decoded.counts;return decoded;
    }
    for(const type of ['new','old']) {
      let received=0;
      for(let n=1;n<=maxPages;n++) {
        const current=await read(type,n,'page');received+=current.rows.length;
        if(received>expectedCounts[type] || !current.rows.length && received<expectedCounts[type])throw Error('Partial provider history enumeration');
        if(received===expectedCounts[type])break;
        if(n===maxPages)throw Error('Provider history page limit reached');
      }
    }
    for(const type of ['new','old'])await read(type,1,'stability');
    const targets=snapshot.responses.filter(proof=>proof.purpose==='page').flatMap(proof=>readResponse(proof).rows.filter(row=>row.url===sourceUrl).map(row=>({row,type:proof.type,page:proof.page})));
    const target=phase==='after' && targets.length===1?targets[0]:null;
    if(target && target.page!==1)throw Error('Target history pagination UI has not been observed');
    const historyPage=await context.newPage();
    try {
      await historyPage.route('**/*',allowedUiRead);
      const pageUrl=target?.type==='old'?`${origin}/student/old_applications/?dashboard_source=recent`:`${origin}/student/applications/?dashboard_source=recent`;
      await historyPage.goto(pageUrl,{waitUntil:'domcontentloaded',timeout:timeoutMs});
      let card=null;
      if(target) {
        await historyPage.locator(`a[href="${sourceUrl}"]`).first().waitFor({state:'visible',timeout:timeoutMs});
        card=await historyPage.evaluate(({sourceUrl,review})=>{
          const sources=[...document.querySelectorAll('a')].filter(link=>link.href===sourceUrl);
          if(sources.length!==1)throw Error('Exact rendered source anchor missing or repeated');
          let node=sources[0].parentElement;
          while(node && !(node.tagName==='DIV' && ['flex','flex-row','items-center','text-sm','lg:hidden'].every(name=>node.classList.contains(name))))node=node.parentElement;
          if(!node || ![...node.querySelectorAll('a')].some(link=>link.href.split('?')[0]===review) || !node.checkVisibility())throw Error('Actual same-card history proof unavailable');
          return {outerHTML:node.outerHTML,visible:true};
        },{sourceUrl,review:target.row.application_review_url});
        card.sha256=sha(Buffer.from(card.outerHTML));
      }
      const pageHtml=await historyPage.content(),screenshot=await historyPage.screenshot({fullPage:true,type:'png'});
      snapshot.ui={pageUrl:historyPage.url(),observedAt:new Date().toISOString(),pageHtml,pageSha256:sha(Buffer.from(pageHtml)),pageArtifact:save(path.join(dir,'history-ui.html'),Buffer.from(pageHtml)),screenshotBase64:screenshot.toString('base64'),screenshotSha256:sha(screenshot),screenshotArtifact:save(path.join(dir,'history-ui.png'),screenshot),card};
    } finally {await historyPage.close();}
    snapshot.completedAt=new Date().toISOString();inspectInternshalaHistorySnapshot(snapshot);
    save(path.join(dir,'snapshot.json'),Buffer.from(JSON.stringify(snapshot,null,2)));
    return phase==='after'?{version:INTERNSHALA_HISTORY_VERSION,before,after:snapshot}:snapshot;
  };
}
