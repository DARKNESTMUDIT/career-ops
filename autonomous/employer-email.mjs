import { isIP } from 'node:net';
import { htmlToText } from '../providers/_html-to-text.mjs';
import { decodeEntities } from '../providers/_html-entities.mjs';

const MAX_BYTES = 1024 * 1024;
const mailbox = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const containsMailbox = (text, recipient) => (text.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}/g) || []).includes(recipient);
const closedOrChallenge = /\b(?:this (?:job|role|position) (?:is |has been )?(?:closed|filled)|(?:applications?|position|job|role) (?:are |is )?(?:now )?closed|no longer accepting applications|no longer available|verify (?:that )?you are human|captcha|access denied|checking your browser|just a moment)\b/i;

// Capture href-only mailboxes as explicitly labelled source evidence. Never
// infer a role from the rest of a multi-role careers page: the application's
// subject must name the reviewed role. JSON preserves decoded body newlines
// without letting a body manufacture additional evidence lines or headers.
function applicationMailtoEvidence(html, channel) {
  const source = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|template|noscript)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const role = channel.role.trim().replace(/\s+/g, ' ').toLowerCase();
  const lines = new Set();
  let examined = 0;
  for (const anchor of source.matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>[\s\S]*?<\/a\s*>/gi)) {
    if (++examined > 200) break;
    // Parse every attribute so text inside another quoted attribute cannot
    // masquerade as href. Malformed/unquoted attributes fail closed.
    const attributes = [];
    const attributePattern = /\s+([^\s=<>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/gy;
    let offset = 0;
    while (offset < anchor[1].trimEnd().length) {
      attributePattern.lastIndex = offset;
      const attribute = attributePattern.exec(anchor[1]);
      if (!attribute) break;
      attributes.push([attribute[1].toLowerCase(), attribute[2] ?? attribute[3]]);
      offset = attributePattern.lastIndex;
    }
    if (offset !== anchor[1].trimEnd().length) continue;
    const hrefs = attributes.filter(([name]) => name === 'href');
    if (hrefs.length !== 1 || typeof hrefs[0][1] !== 'string') continue;
    const href = decodeEntities(hrefs[0][1]);
    if (href.length > 8192 || !/^mailto:/i.test(href) || /[\x00-\x1f\x7f#]/.test(href)) continue;
    try {
      const parts = href.slice(7).split('?');
      if (parts.length !== 2) continue;
      const recipient = decodeURIComponent(parts[0]);
      if (recipient !== channel.recipient || !mailbox.test(recipient) || recipient.length > 254 || /[%\s,;<>]/.test(recipient)) continue;
      const [local, domain] = recipient.split('@');
      if (local.length > 64 || /^\.|\.$|\.\./.test(local) || !domain.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) continue;
      const fields = new Map();
      let valid = true;
      // decodeURIComponent, rather than URLSearchParams, preserves literal +.
      for (const field of parts[1].split('&')) {
        const separator = field.indexOf('=');
        if (separator < 0) { valid = false; break; }
        const key = decodeURIComponent(field.slice(0, separator)).toLowerCase();
        const value = decodeURIComponent(field.slice(separator + 1));
        if (!['subject', 'body'].includes(key) || fields.has(key)) { valid = false; break; }
        fields.set(key, value);
      }
      const subject = fields.get('subject') || '';
      const body = fields.get('body') || '';
      if (!valid || /[\x00-\x1f\x7f]/.test(subject) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)) continue;
      const normalizedSubject = subject.replace(/\s+/g, ' ').toLowerCase();
      const subjectRole = normalizedSubject.replace(/^(?:application|apply) for /, '').replace(/ (?:position|role)$/, '');
      if (!/^(?:application|apply) for /.test(normalizedSubject) || subjectRole !== role) continue;
      const evidence = `Published application mailto: ${JSON.stringify({ recipient, subject, body })}`;
      if (evidence.length <= 10000) lines.add(evidence);
      if ([...lines].join('\n').length > 12000) return '';
    } catch { /* Malformed percent-encoding is not application evidence. */ }
  }
  return [...lines].join('\n');
}

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
      const visible = htmlToText(html, { maxChars: 50000 });
      if (!visible || visible.length >= 50000) return null;
      const evidence = applicationMailtoEvidence(html, channel);
      const text = evidence ? `${visible}\n${evidence}` : visible;
      if (!text || text.length >= 50000 || !text.includes(channel.quote) || !containsMailbox(text, channel.recipient) || !text.toLowerCase().includes(channel.role.trim().replace(/\s+/g, ' ').toLowerCase()) || closedOrChallenge.test(text)) return null;
      return { text, sourceUrl: url, method: 'employer-email-page' };
    }
  } catch { return null; }
  return null;
}
