import { createHash } from 'node:crypto';
import { htmlToText } from '../providers/_html-to-text.mjs';

export const HYPERPROSPECT_CAREERS_URL='https://hyperprospect.com/careers';
export const HYPERPROSPECT_ROLE="Founder's Office Intern";
export const HYPERPROSPECT_APPLICATION_MAILTO="mailto:support@hyperprospect.com?subject=Application: Founder's Office Intern";
const BYTE_CAP=1048576, TEXT_CAP=50000;

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(m=>[m[1].toLowerCase(),m[2]??m[3]??m[4]]));
}
function hasClass(tag,name) {return (attributes(tag).class||'').split(/\s+/).includes(name);}
function divs(markup,name) {
  const tags=[...markup.matchAll(/<\/?div\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)];
  const matches=[];
  for(let i=0;i<tags.length;i++) {
    const start=tags[i];
    if(/^<\/div/i.test(start[0]) || !hasClass(start[0],name))continue;
    let depth=0,closed=false;
    for(let j=i;j<tags.length;j++) {
      depth+=/^<\/div/i.test(tags[j][0])?-1:1;
      if(depth===0){matches.push(markup.slice(start.index,tags[j].index+tags[j][0].length));closed=true;break;}
    }
    if(!closed)throw Error(`HyperProspect ${name} container truncated`);
  }
  return matches;
}
function oneDiv(markup,name) {
  const matches=divs(markup,name);
  if(matches.length!==1)throw Error(`HyperProspect ${name} container missing or ambiguous`);
  return matches[0];
}
function fullText(markup,maxChars=40001) {
  const value=htmlToText(markup,{maxChars});
  if(value.length>=maxChars)throw Error('HyperProspect role text exceeds capture bound');
  return value;
}
async function boundedHtml(response) {
  if(Number(response.headers.get('content-length'))>BYTE_CAP)throw Error('HyperProspect HTML exceeds 1 MB bound');
  const reader=response.body?.getReader();
  if(!reader)throw Error('HyperProspect response body unavailable');
  const chunks=[];let size=0;
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>BYTE_CAP){await reader.cancel();throw Error('HyperProspect HTML exceeds 1 MB bound');}chunks.push(value);}
  } finally {reader.releaseLock();}
  return Buffer.concat(chunks).toString('utf8');
}

// Public source evidence only. The mailto is quoted as evidence; this helper
// never authorizes sending or decides candidate eligibility.
export async function fetchHyperprospectPosting(url,{fetcher=fetch}={}) {
  if(url!==HYPERPROSPECT_CAREERS_URL)return null;
  const response=await fetcher(url,{method:'GET',redirect:'manual',headers:{Accept:'text/html'},signal:AbortSignal.timeout(20000)});
  if(response.status!==200 || (response.url && response.url!==url) || !/^text\/html\b/i.test(response.headers.get('content-type')||''))throw Error('HyperProspect careers page unavailable or redirected');
  const html=await boundedHtml(response);
  const body=html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1];
  if(!body)throw Error('HyperProspect HTML body missing or truncated');
  const clean=body.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  if(/verify (?:that )?you are human|captcha challenge|access denied|checking your browser/i.test(fullText(clean,100001)))throw Error('HyperProspect page requires interaction');
  const title=html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  if(!title || !/^Careers at HyperProspect\b/.test(fullText(title)))throw Error('HyperProspect employer page identity changed');

  const cards=divs(clean,'acc-item');
  const target=cards.filter(card=>{
    const names=divs(card,'t');
    return names.length===1 && fullText(names[0])===HYPERPROSPECT_ROLE;
  });
  if(target.length!==1)throw Error('HyperProspect exact role card missing or ambiguous');
  const card=target[0];
  const meta=oneDiv(card,'meta'),detail=oneDiv(card,'acc-body');
  const roleText=fullText(`${meta}\n${detail}`);
  if(roleText.length<100 || !/\bRemote\b/.test(fullText(meta)) || !/\bInternship\b/.test(fullText(meta)) || !/\bOperations\b/.test(fullText(meta)))throw Error('HyperProspect role details incomplete');
  if(/applications? (?:are |is )?closed|no longer accepting applications|position (?:is |has been )?(?:closed|filled)|role (?:is )?expired|apply by\s+\d{1,2}[^\n]{0,40}(?:20\d\d)/i.test(roleText))throw Error('HyperProspect role closed, expired or date-sensitive');
  const links=[...card.matchAll(/<a\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)].map(m=>attributes(m[0]).href);
  if(links.length!==1 || links[0]!==HYPERPROSPECT_APPLICATION_MAILTO)throw Error('HyperProspect exact role application mailto missing or changed');

  const policyCards=divs(clean,'card').filter(value=>/<h3\b[^>]*>\s*Remote-first, always\s*<\/h3>/i.test(value));
  if(policyCards.length!==1)throw Error('HyperProspect global remote policy missing or ambiguous');
  const policyMatch=policyCards[0].match(/<h3\b[^>]*>\s*Remote-first, always\s*<\/h3>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i);
  if(!policyMatch)throw Error('HyperProspect global remote policy text unavailable');
  const remotePolicy=fullText(policyMatch[1],2001);
  if(remotePolicy.length<80 || !remotePolicy.startsWith('Work from wherever you do your best thinking.'))throw Error('HyperProspect global remote policy changed');

  const application={role:HYPERPROSPECT_ROLE,recipient:'support@hyperprospect.com',subject:`Application: ${HYPERPROSPECT_ROLE}`,href:links[0]};
  const text=`Employer page title: ${fullText(title)}\nExact open role: ${HYPERPROSPECT_ROLE}\nRole-specific published details and requirements:\n${roleText}\nCompany-wide remote work policy (not role-specific geographic eligibility):\nRemote-first, always. ${remotePolicy}\nExact role's native application email link (published by employer): ${JSON.stringify(application)}`;
  if(text.length>=TEXT_CAP)throw Error('HyperProspect capture exceeds 50,000 characters');
  return {text,sourceUrl:url,method:'hyperprospect-public-careers-exact-role',sourceHash:createHash('sha256').update(text).digest('hex')};
}
