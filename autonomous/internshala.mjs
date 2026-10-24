import { jdHtmlToText } from '../browser-extract.mjs';

const BYTE_CAP=1048576, TEXT_CAP=50000;
function identity(value) {
  try {
    const u=new URL(value);
    const match=/^\/internship\/detail\/([a-z0-9-]*[a-z-])(\d+)\/?$/i.exec(u.pathname);
    if(u.protocol!=='https:' || u.hostname!=='internshala.com' || u.port || u.username || u.password || u.search || u.hash || !match)return null;
    return {id:match[2],url:u.href.replace(/\/$/,'')};
  } catch {return null;}
}
function samePosting(a,b) {const x=identity(a),y=identity(b);return !!x && !!y && x.id===y.id;}
function attrs(text) {
  return Object.fromEntries([...text.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(m=>[m[1].toLowerCase(),m[2]??m[3]??m[4]]));
}
function schemaType(node,name) {return [node?.['@type']].flat().some(type=>[name,`https://schema.org/${name}`,`http://schema.org/${name}`].includes(type));}
function collectNodes(value,all=[],depth=0) {
  if(depth>30 || all.length>10000)throw new Error('Internshala structured data exceeds safe bounds');
  if(Array.isArray(value)){for(const v of value)collectNodes(v,all,depth+1);}
  else if(value && typeof value==='object'){all.push(value);for(const v of Object.values(value))if(v && typeof v==='object')collectNodes(v,all,depth+1);}
  return all;
}
async function boundedBody(response) {
  if(Number(response.headers.get('content-length'))>BYTE_CAP)throw new Error('Internshala HTML exceeds 1 MB bound');
  const chunks=[];let bytes=0;
  if(!response.body?.getReader)throw new Error('Internshala response body unavailable');
  const reader=response.body.getReader();
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>BYTE_CAP)throw new Error('Internshala HTML exceeds 1 MB bound');chunks.push(Buffer.from(value));}
  } catch(error) {await reader.cancel().catch(()=>{});throw error;}
  return Buffer.concat(chunks).toString('utf8');
}
async function publicHtml(url,fetcher) {
  const signal=AbortSignal.timeout(20000);let current=url;
  for(let redirects=0;redirects<=3;redirects++) {
    const response=await fetcher(current,{method:'GET',redirect:'manual',headers:{Accept:'text/html'},signal});
    if(response.url && !samePosting(response.url,url))throw new Error('Internshala response posting identity changed');
    if(response.status>=300 && response.status<400) {
      const location=response.headers.get('location');
      if(!location)throw new Error('Internshala redirect lacks posting identity');
      const next=new URL(location,current).href;
      if(!samePosting(next,url))throw new Error('Internshala redirect left exact HTTPS posting identity');
      current=next;continue;
    }
    if([404,410].includes(response.status))throw new Error('Internshala posting closed or expired');
    if(!response.ok || !/^text\/html\b/i.test(response.headers.get('content-type')||''))throw new Error(`Internshala public HTML unavailable: ${response.status}`);
    return {html:await boundedBody(response),finalUrl:current};
  }
  throw new Error('Internshala redirect limit exceeded');
}
function choosePosting(html,url) {
  const canonical=[...html.matchAll(/<link\b([^>]*)>/gi)].map(m=>attrs(m[1])).filter(a=>a.rel?.toLowerCase().split(/\s+/).includes('canonical')).map(a=>a.href && new URL(a.href,url).href);
  if(canonical.some(value=>!value || !samePosting(value,url)))throw new Error('Internshala canonical posting identity mismatch');
  const nodes=[];
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if(attrs(match[1]).type?.trim().toLowerCase()!=='application/ld+json')continue;
    let json;try{json=JSON.parse(match[2]);}catch{throw new Error('Internshala structured data is malformed');}
    collectNodes(json,nodes);
  }
  const postings=nodes.filter(node=>schemaType(node,'JobPosting'));
  if(!postings.length)return null;
  const breadcrumbs=nodes.filter(node=>schemaType(node,'BreadcrumbList')).map(node=>node.itemListElement?.at(-1)?.item).map(item=>typeof item==='string'?item:item?.['@id']);
  const pageBound=canonical.some(value=>samePosting(value,url)) || breadcrumbs.some(value=>samePosting(value,url));
  if(!pageBound)throw new Error('Internshala structured posting lacks exact canonical/Breadcrumb identity');
  const nodeUrl=node=>typeof node.url==='string'?node.url:typeof node.mainEntityOfPage==='string'?node.mainEntityOfPage:node.mainEntityOfPage?.['@id'];
  const matching=postings.filter(node=>{const own=nodeUrl(node);return own?samePosting(new URL(own,url).href,url):postings.length===1;});
  if(matching.length!==1)throw new Error('Internshala structured posting is unmatched or ambiguous');
  return matching[0];
}

// The public detail page keeps the role header and the full employer-written
// description in separate siblings. Navigation, sign-in prompts and similar
// jobs are outside these exact sections. Require a unique enclosing article
// and unique role sections so a changed page layout cannot silently broaden
// the evidence back to the whole body.
function uniqueDiv(markup,className) {
  const tags=[...markup.matchAll(/<\/?div\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)];
  const openings=tags.filter(m=>!/^<\/div/i.test(m[0]) && (attrs(m[0]).class||'').split(/\s+/).includes(className));
  if(openings.length!==1)throw new Error(`Internshala role ${className} container missing or ambiguous`);
  const opening=openings[0];let depth=0;
  for(const tag of tags) {
    if(tag.index<opening.index)continue;
    depth+=/^<\/div/i.test(tag[0])?-1:1;
    if(depth===0)return markup.slice(opening.index,tag.index+tag[0].length);
  }
  throw new Error(`Internshala role ${className} container truncated`);
}
function roleMarkup(bodyMarkup) {
  const clean=bodyMarkup
    .replace(/<!--[\s\S]*?-->/g,'')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  const article=uniqueDiv(clean,'detail_view');
  const meta=uniqueDiv(article,'internship_meta');
  const details=uniqueDiv(article,'internship_details');
  return {meta,details};
}

// Capture public source evidence only. No title-based eligibility decisions,
// inferred locations, application interaction or merging of recommended roles.
export async function fetchInternshalaPosting(url,{fetcher=fetch}={}) {
  if(!identity(url))return null;
  const {html,finalUrl}=await publicHtml(url,fetcher);
  const bodyMarkup=html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1];
  if(!bodyMarkup)throw new Error('Internshala HTML body missing or truncated');
  if(/verify you are human|captcha challenge|access denied|checking your browser/i.test(jdHtmlToText(bodyMarkup)))throw new Error('Internshala public page requires interaction');
  const item=choosePosting(html,url);
  if(!item)return null;
  const {meta,details}=roleMarkup(bodyMarkup);
  const roleDetails=jdHtmlToText(details);
  const visible=`${jdHtmlToText(meta)}\n${roleDetails}`;
  const description=jdHtmlToText(item.description);
  if(description.length<100 || roleDetails.length<100)throw new Error('Internshala full descriptions unavailable');
  if(/no longer accepting applications|applications? (?:are |is )?closed|position (?:is |has been )?(?:closed|filled)|internship (?:is )?closed|posting (?:has )?expired/i.test(`${description}\n${visible}`))throw new Error('Internshala posting closed or expired');
  if(item.validThrough) {
    const expires=Date.parse(item.validThrough);
    if(!Number.isFinite(expires))throw new Error('Internshala expiry metadata invalid');
    if(expires<Date.now())throw new Error('Internshala posting closed or expired');
  }
  const metadata={};
  for(const key of ['title','identifier','applicantLocationRequirements','jobLocationType','qualifications','educationRequirements','hiringOrganization','employmentType','datePosted','validThrough'])if(Object.hasOwn(item,key))metadata[key]=item[key];
  const text=`Internshala exact-posting public role text (source: ${finalUrl}):\n${visible}\n\nInternshala exact-posting JobPosting JSON-LD description (independent source section; retain any differences from body text):\n${description}\n\nInternshala exact-posting JobPosting JSON-LD metadata (verbatim values; country codes are provider data):\n${JSON.stringify(metadata)}`;
  if(text.length>=TEXT_CAP || description.endsWith('…'))throw new Error('Internshala capture exceeds 50,000 characters or is truncated');
  return {url,sourceUrl:url,title:typeof item.title==='string'?item.title:'',text,method:'internshala-public-html-and-jsonld'};
}
