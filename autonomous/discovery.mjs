import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fetchJdViaKnownApi } from '../browser-extract.mjs';
import { adapterFor } from './browser.mjs';
import { fetchUnstopPosting } from './unstop.mjs';
import { fetchSmartRecruitersPosting } from './smartrecruiters.mjs';
import { fetchEmployerEmailPosting } from './employer-email.mjs';
import { fetchMichmerPosting } from './michmer-form.mjs';
import { fetchInternshalaPosting } from './internshala.mjs';
import { fetchIsocodePosting, ISOCODE_POSTING_URL } from './isocode-posting.mjs';
import { fetchHyperprospectPosting, HYPERPROSPECT_CAREERS_URL } from './hyperprospect-posting.mjs';
const exec = promisify(execFile);
export async function fetchFullPosting(url,channel) {
  if(url===ISOCODE_POSTING_URL)return fetchIsocodePosting(url);
  if(url===HYPERPROSPECT_CAREERS_URL)return fetchHyperprospectPosting(url);
  if(channel){const capture=await fetchEmployerEmailPosting(url,channel);if(!capture)throw new Error('Reviewed employer application page unavailable or changed');return capture;}
  if(adapterFor(url)==='michmer')return fetchMichmerPosting(url);
  if(new URL(url).hostname==='internshala.com') {
    const structured=await fetchInternshalaPosting(url);
    if(structured)return structured;
  }
  const u = new URL(url);
  if (u.protocol !== 'https:' || (!adapterFor(url) && !['internshala.com','unstop.com','www.unstop.com','jobs.smartrecruiters.com'].includes(u.hostname))) throw new Error('Unsupported discovery source');
  let capture = await fetchSmartRecruitersPosting(url);
  if(u.hostname==='jobs.smartrecruiters.com' && !capture)throw new Error('Exact SmartRecruiters posting URL required');
  if(!capture)capture = await fetchUnstopPosting(url);
  if(!capture)capture = await fetchJdViaKnownApi(url, 50000, 15000);
  if (!capture) {
    const { stdout } = await exec(process.execPath, [fileURLToPath(new URL('../browser-extract.mjs', import.meta.url)), url, '--mode','jd','--max-chars','50000','--timeout','20000'], { timeout:30000, maxBuffer:1024*1024 });
    capture = JSON.parse(stdout);
  }
  if (!capture?.text || capture.text.length < 100) throw new Error('Full posting unavailable');
  if (/position (?:is |has been )?(?:closed|filled)|no longer accepting applications|application(?:s)? (?:are |is )?closed|internship (?:is )?closed|deadline (?:has )?passed|job not found|posting (?:has )?expired/i.test(capture.text)) throw new Error('Posting closed or expired');
  if (/verify you are human|captcha challenge|access denied|sign in to view/i.test(capture.text)) throw new Error('Posting requires browser interaction');
  if (capture.text.endsWith('…') || capture.text.length >= 50000) throw new Error('Posting capture truncated');
  return capture;
}
