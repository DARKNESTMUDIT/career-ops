import { isIP } from 'node:net';
import { htmlToText } from '../providers/_html-to-text.mjs';

const MAX_BYTES = 1024 * 1024;
const mailbox = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const containsMailbox = (text, recipient) => (text.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}/g) || []).includes(recipient);
const closedOrChallenge = /\b(?:this (?:job|role|position) (?:is |has been )?(?:closed|filled)|(?:applications?|position|job|role) (?:are |is )?(?:now )?closed|no longer accepting applications|no longer available|verify (?:that )?you are human|captcha|access denied|checking your browser|just a moment)\b/i;

function publicPage(value) {
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || isIP(host.replace(/^\[|\]$/g, ''))) return null;
    if (host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) return null;
    if (/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host)) return null;
    return url;
  } catch { return null; }
}

async function boundedHTML(response) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) return null;
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

// Only a locally reviewed, role-specific email channel authorizes this fetch.
// Its previous postingHash is intentionally not consulted: a changed page must
// be capturable so the later draft/send boundary can detect stale approval.
export async function fetchEmployerEmailPosting(url, channel, { fetcher = fetch } = {}) {
  const target = publicPage(url);
  if (!target || channel?.verified !== true || channel.roleUrl !== url || channel.sourceUrl !== url || channel.employerHost !== target.hostname) return null;
  if (typeof channel.recipient !== 'string' || !mailbox.test(channel.recipient) || typeof channel.quote !== 'string' || !channel.quote.trim() || !containsMailbox(channel.quote, channel.recipient) || typeof channel.role !== 'string' || !channel.role.trim()) return null;
  const signal = AbortSignal.timeout(15000);
  let current = target;
  try {
    for (let redirects = 0; redirects <= 2; redirects++) {
      const response = await fetcher(current.href, { redirect: 'manual', signal, headers: { Accept: 'text/html' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 2) return null;
        const next = publicPage(new URL(location, current).href);
        if (!next || next.origin !== target.origin) return null;
        current = next;
        continue;
      }
      if (response.status !== 200 || !/^text\/html(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); return null; }
      // Defend against a nonconforming fetcher following a redirect itself.
      if (response.url && new URL(response.url).origin !== target.origin) return null;
      const html = await boundedHTML(response);
      if (html === null) return null;
      const text = htmlToText(html, { maxChars: 50000 });
      if (!text || text.length >= 50000 || !text.includes(channel.quote) || !containsMailbox(text, channel.recipient) || !text.toLowerCase().includes(channel.role.trim().replace(/\s+/g, ' ').toLowerCase()) || closedOrChallenge.test(text)) return null;
      return { text, sourceUrl: url, method: 'employer-email-page' };
    }
  } catch { return null; }
  return null;
}
