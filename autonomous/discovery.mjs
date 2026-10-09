import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fetchJdViaKnownApi } from '../browser-extract.mjs';
import { adapterFor } from './browser.mjs';
const exec = promisify(execFile);
export async function fetchFullPosting(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || (!adapterFor(url) && !['internshala.com','unstop.com','www.unstop.com'].includes(u.hostname))) throw new Error('Unsupported discovery source');
  let capture = await fetchJdViaKnownApi(url, 50000, 15000);
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
