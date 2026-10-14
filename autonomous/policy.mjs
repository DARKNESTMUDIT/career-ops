import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const dayInIndia = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const normalize = s => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const identityKey = (company, role) => hash(`${normalize(company)}\n${normalize(role)}`);

// Exact quotation alone does not prove the model's extracted number/date was
// actually in that quotation. Ambiguous numeric dates and derived dates fail
// closed; the planner must obtain explicit evidence or leave the field unknown.
export function quantifiedEvidenceIssues(job) {
  const issues=[];
  for(const key of ['start','end','deadline']) {
    if(!validDate(job[key]))continue; // assess() reports absent/invalid values.
    const [year,month,day]=job[key].split('-').map(Number);
    const name=['January','February','March','April','May','June','July','August','September','October','November','December'][month-1];
    const quoted=String(job.evidence?.[key] || '');
    const monthPattern=`(?:${name}|${name.slice(0,3)}\\.?)`;
    const spelled=new RegExp(`\\b(?:${monthPattern}\\s+0?${day}(?:st|nd|rd|th)?[,]?\\s+${year}|0?${day}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${monthPattern}[,]?\\s+${year})\\b`,'i');
    if(!quoted.includes(job[key]) && !spelled.test(quoted))issues.push(`${key} value is not explicit in its evidence`);
  }
  if(Number.isFinite(job.hours)) {
    const value=String(job.hours).replace('.','\\.');
    const hours=new RegExp(`\\b${value}\\s*(?:hours?|hrs?|h)\\s*(?:per\\s+week|a\\s+week|weekly|/\\s*week)\\b`,'i');
    if(!hours.test(String(job.evidence?.hours || '')))issues.push('Weekly hours value is not explicit in its evidence');
  }
  return issues;
}

// A model extracts evidence. It cannot waive these gates or authorize an action.
export function assess(job, policy, today = dayInIndia()) {
  const missing = [], reject = [];
  if (!job || typeof job !== 'object') return { state: 'exception', reasons: ['Invalid evaluation'] };
  const track = policy.tracks[job.track];
  if (!track) missing.push('Unknown track');
  if (typeof job.jd !== 'string' || job.jd.trim().length < 100) missing.push('Full job description missing');
  if (job.active !== true) missing.push('Active posting not verified');
  for (const key of ['company', 'role', 'start', 'end', 'deadline', 'hours', 'indiaEligible', 'studentEligible', 'remote', 'duties', 'pay', 'fit']) {
    if (job[key] === null || job[key] === undefined || job[key] === '') missing.push(`Missing ${key}`);
    else {
      const quote = job.evidence?.[key];
      if (typeof quote !== 'string' || quote.trim().length < 3 || !job.jd?.includes(quote)) missing.push(`Unverified ${key} evidence`);
    }
  }
  for (const key of ['start', 'end', 'deadline']) if (!validDate(job[key])) missing.push(`Invalid ${key}`);
  if (validDate(job.deadline) && job.deadline < today) reject.push('Application deadline passed');
  if (job.indiaEligible === false) reject.push('Not eligible from India');
  if (job.studentEligible === false) reject.push('Student requirements incompatible');
  if (!['boolean'].includes(typeof job.indiaEligible) || typeof job.studentEligible !== 'boolean' || typeof job.remote !== 'boolean') missing.push('Eligibility requires explicit booleans');
  if (!Number.isFinite(job.hours) || job.hours <= 0) missing.push('Invalid hours');
  if (!Number.isFinite(job.fit) || job.fit < 0 || job.fit > 5) missing.push('Invalid fit');
  if (!['substantive', 'excluded'].includes(job.duties)) missing.push('Duties not classified');
  if (job.duties === 'excluded') reject.push('Sales, lead generation or routine marketing dominated duties');
  if (!['paid', 'unpaid', 'undisclosed'].includes(job.pay)) missing.push('Pay not classified');
  if (track) {
    if (track.latest_end < today) reject.push('Track window closed');
    if (job.start < today || job.end < job.start || job.start < (track.earliest_start === 'immediate' ? today : track.earliest_start) || job.end > track.latest_end) reject.push('Dates outside availability');
    if (validDate(job.start) && validDate(job.end)) {
      const limit = new Date(`${job.start}T00:00:00Z`);
      limit.setUTCMonth(limit.getUTCMonth() + track.max_months);
      if (new Date(job.end) >= limit) reject.push('Duration exceeds track maximum');
    }
    if (job.hours > track.max_hours_per_week) reject.push('Hours exceed availability');
    if (job.track === 'remote' && job.remote === false) reject.push('Remote track requires fully remote');
    if (job.remote === false && job.country !== 'India') reject.push('On-site must be in India');
    if (job.remote === false && (!job.evidence?.country || !job.jd?.includes(job.evidence.country))) missing.push('On-site country unverified');
  }
  if (job.pay === 'unpaid') {
    if (job.fit < policy.unpaidFit) reject.push('Unpaid fit below threshold');
    for (const key of ['credibleEmployer', 'project', 'supervision']) if (job[key] !== true || !job.evidence?.[key] || !job.jd?.includes(job.evidence[key])) missing.push(`Unpaid ${key} evidence required`);
  } else if (job.fit < policy.minimumFit) reject.push('Fit below threshold');
  return { state: reject.length ? 'rejected' : missing.length ? 'exception' : 'eligible', reasons: [...reject, ...missing] };
}

export function validateClaims(claims, sources) {
  if (!Array.isArray(claims) || !claims.length) throw new Error('No source-backed resume claims');
  for (const c of claims) {
    if (!c || !Object.hasOwn(sources, c.source) || typeof c.quote !== 'string' || !c.quote.trim() || !sources[c.source].includes(c.quote)) throw new Error('Unsupported candidate claim');
    // Exact quotations in v1 deliberately avoid numeric or scope drift in paraphrases.
    if (c.text !== c.quote) throw new Error('Claim differs from approved source');
  }
  return true;
}
