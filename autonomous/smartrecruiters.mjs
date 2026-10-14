import {htmlToText} from '../providers/_html-to-text.mjs';

function postingIdentity(url) {
  const u=new URL(url);
  if(u.protocol!=='https:' || u.hostname!=='jobs.smartrecruiters.com' || u.username || u.password)return null;
  const match=u.pathname.match(/^\/([A-Za-z0-9_-]+)\/(\d+)(?:-[^/]+)?\/?$/);
  return match && {company:match[1],id:match[2]};
}

// Discovery only: this does not add a submission adapter or infer schedule,
// eligibility, or remote work from employment labels or absent metadata.
export async function fetchSmartRecruitersPosting(url,{fetcher=fetch}={}) {
  const target=postingIdentity(url);
  if(!target)return null;
  const apiSource=`https://api.smartrecruiters.com/v1/companies/${target.company}/postings/${target.id}`;
  const response=await fetcher(apiSource,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(response.status===404 || response.status===410)throw new Error('Posting closed or expired');
  if(!response.ok)throw new Error(`SmartRecruiters capture failed: HTTP ${response.status}`);
  const item=await response.json();
  const canonical=item.postingUrl && postingIdentity(item.postingUrl);
  if(String(item.id)!==target.id || item.company?.identifier!==target.company || !canonical || canonical.id!==target.id || canonical.company!==target.company)throw new Error('SmartRecruiters posting identity mismatch');
  if(item.active!==true || item.visibility!=='PUBLIC')throw new Error('SmartRecruiters posting is not verified public and active');
  const sections=item.jobAd?.sections;
  if(!sections?.jobDescription?.text || !sections?.qualifications?.text)throw new Error('SmartRecruiters full description or qualifications unavailable');
  const description=htmlToText(['companyDescription','jobDescription','qualifications','additionalInformation'].map(key=>sections[key]?.text || '').join('\n'),{maxChars:50000});
  if(description.length<100 || description.length>=50000)throw new Error('SmartRecruiters description missing or truncated');
  const metadata={title:item.name,company:item.company,location:item.location,employmentType:item.typeOfEmployment,releasedDate:item.releasedDate};
  const text=`${description}\n\nSmartRecruiters API metadata (release date is NOT an internship start date):\n${JSON.stringify(metadata)}`;
  if(text.length>=50000)throw new Error('SmartRecruiters posting capture truncated');
  return {text,sourceUrl:url,apiSource,method:'smartrecruiters-public-api'};
}
