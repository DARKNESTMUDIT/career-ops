import {htmlToText} from '../providers/_html-to-text.mjs';

export const ISOCODE_POSTING_URL='https://careers.isocodelabs.com/roles/product-manager-intern';

// Preserve all structured requirements, rather than selecting only the visible
// description. This capture authorizes no upload or application submission.
export async function fetchIsocodePosting(url,{fetcher=fetch}={}) {
  if(url!==ISOCODE_POSTING_URL)return null;
  const response=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000)});
  if(response.status!==200 || (response.url && response.url!==url) || !/^text\/html\b/i.test(response.headers.get('content-type')||''))throw Error('Isocode posting unavailable');
  const reader=response.body?.getReader();if(!reader)throw Error('Isocode source body unavailable');
  const chunks=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1048576){await reader.cancel();throw Error('Isocode posting exceeds capture bound');}chunks.push(value);}}finally{reader.releaseLock();}
  const html=Buffer.concat(chunks).toString('utf8');
  const visible=htmlToText(html,{maxChars:50000});
  if(/verify (?:that )?you are human|captcha challenge|access denied|applications (?:are )?closed|no longer accepting applications|position (?:is |has been )?(?:closed|filled)/i.test(visible))throw Error('Isocode posting closed or challenged');
  const postings=[];
  for(const match of html.matchAll(/<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed;try{parsed=JSON.parse(match[1]);}catch{throw Error('Invalid Isocode structured posting');}
    const values=Array.isArray(parsed)?parsed:parsed?.['@graph']||[parsed];
    for(const value of values)if(value?.['@type']==='JobPosting')postings.push(value);
  }
  const job=postings[0];
  if(postings.length!==1 || job.identifier?.value!=='product-manager-intern' || job.title!=='Product Management Intern' || (job.url && job.url!==url) || !job.hiringOrganization?.name)throw Error('Isocode exact posting identity changed');
  if(job.validThrough && (!Number.isFinite(Date.parse(job.validThrough)) || Date.parse(job.validThrough)<Date.now()))throw Error('Isocode posting expired');
  const normalized=html.replaceAll('\\"','"');
  if(!normalized.includes('"roleKey":"product-manager-intern"') || !normalized.includes('"status":"open"'))throw Error('Isocode role is not verified open');
  if(typeof job.description!=='string')throw Error('Isocode full requirements unavailable');
  const description=htmlToText(job.description,{maxChars:40000});
  const text=`${job.title}\n${description}\nStructured employer JobPosting metadata: ${JSON.stringify(job)}`;
  if(description.length<100 || description.length>=40000 || text.length>=50000)throw Error('Isocode requirements missing or truncated');
  return {text,sourceUrl:url,method:'isocode-structured-posting'};
}
