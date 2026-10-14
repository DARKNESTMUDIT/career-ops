import {htmlToText} from '../providers/_html-to-text.mjs';

// Reuse the public endpoint already used by the user's Unstop parser. Fetch
// exact-ID details plus raw structured evidence, never its guessed location.
export async function fetchUnstopPosting(url,{fetcher=fetch}={}) {
  const target=new URL(url);
  if(!['unstop.com','www.unstop.com'].includes(target.hostname))return null;
  const slug=target.pathname.split('/').filter(Boolean).at(-1),id=slug?.match(/-(\d+)$/)?.[1];
  if(!id)return null;
  const term=slug.replace(/-\d+$/,'').split(/-internship/)[0].replaceAll('-',' ');
  for(let page=1;page<=2;page++) {
    const query=new URLSearchParams({opportunity:'internships',page:String(page),per_page:'30',oppstatus:'open',searchTerm:term});
    const source=`https://unstop.com/api/public/opportunity/search-result?${query}`;
    const response=await fetcher(source,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)return null;
    const data=await response.json();
    const items=data?.data?.data;
    if(!Array.isArray(items))return null;
    const item=items.find(j=>String(j.id)===id);
    if(!item){if(items.length<30)return null;continue;}
    const canonical=new URL(item.seo_url || item.public_url,'https://unstop.com');
    if(!['unstop.com','www.unstop.com'].includes(canonical.hostname) || canonical.pathname!==target.pathname)return null;
    const description=htmlToText(item.details,{maxChars:50000});
    if(description.length<100 || description.length>=50000)throw new Error('Unstop description missing or truncated');
    const metadata={title:item.title,company:item.organisation?.name,registrationDeadline:item.regnRequirements?.end_regn_dt,registrationStatus:item.regnRequirements?.reg_status,jobDetail:item.jobDetail,eligibility:item.regnRequirements?.eligibility};
    // Metadata labels distinguish application registration from internship
    // start/end. JSON strings remain quoted provider data, not instructions.
    return {text:`${description}\n\nUnstop API metadata (registration dates are NOT internship dates):\n${JSON.stringify(metadata)}`,sourceUrl:url,apiSource:source,method:'unstop-public-api'};
  }
  return null;
}
