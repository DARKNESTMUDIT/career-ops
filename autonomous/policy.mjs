import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const dayInIndia = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const normalize = s => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const identityKey = (company, role) => hash(`${normalize(company)}\n${normalize(role)}`);

// A planner may list several verbatim excerpts separated by semicolons. Keep
// the original evidence for audit and require every excerpt to exist exactly.
export function exactExcerptList(quote, source) {
  if(typeof quote!=='string' || typeof source!=='string')return false;
  const excerpts=quote.split(';').map(part=>part.trim());
  return excerpts.length>1 && excerpts.every(part=>part.length>=3 && source.includes(part));
}

// Exact quotation alone does not prove the model's extracted number/date was
// actually in that quotation. Ambiguous numeric dates and derived dates fail
// closed; the planner must obtain explicit evidence or leave the field unknown.
export function quantifiedEvidenceIssues(job, policy) {
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
  if(job.durationMonths != null) {
    const words=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
    const numeric=String(job.durationMonths).replace('.','\\.');
    const value=Number.isInteger(job.durationMonths) && words[job.durationMonths] ? `(?:${numeric}|${words[job.durationMonths]})` : numeric;
    const duration=new RegExp(`(?<![\\w.+-])${value}\\s*(?:-\\s*)?months?\\b`,'i');
    const quote=job.evidence?.durationMonths;
    if(!Number.isFinite(job.durationMonths) || job.durationMonths<=0 || typeof quote!=='string' || !job.jd?.includes(quote) || !duration.test(quote))issues.push('Duration in months value is not explicit in its evidence');
  }
  return issues;
}

// Missing employer dates remain unknown. Trusted candidate availability can
// permit them, but never overrides an explicit expired or malformed date.
export function currentSchedule(job, policy, today = dayInIndia()) {
  return ['deadline', 'start'].every(key => job?.[key] == null
    ? policy?.applyWithStatedAvailability === true
    : validDate(job[key]) && job[key] >= today);
}

// A candidate requirement is not an employer workplace fact. Only a literal,
// current remote-friendly quotation permits leaving remote unknown; conflicting
// workplace language still fails closed and all other eligibility gates apply.
function remoteWorkplaceConflict(job) {
  const source=String(job.evidence?.remote || '')+' '+String(job.jd || '');
  // Employer content cannot declare a boundary that conceals a contradiction.
  // This narrow exception deliberately refuses ambiguous workplace language.
  return /\b(?:hybrid|on[\s-]?site|in[\s-]?office)\b|\b(?:not|no|never)\s+(?:fully\s+)?remote\b|\bremote\s+(?:work\s+)?(?:is\s+)?(?:not\s+(?:allowed|available|supported)|unavailable)\b/i.test(source);
}

export function permitsStatedRemoteRequirement(job, policy) {
  if (policy?.applyWithStatedRemoteRequirement !== true || job?.track !== 'remote' || job.remote !== null) return false;
  const quote=job.evidence?.remote, jd=job.jd;
  if (typeof quote !== 'string' || typeof jd !== 'string' || !jd.includes(quote) || !/\bremote[\s-]friendly\b/i.test(quote)) return false;
  if (remoteWorkplaceConflict(job)) return false;
  return true;
}

export function validStudentStatus(value) {
  return typeof value==='string' && value.trim().length>=10 && value.length<=600 && !/[\x00-\x1f\x7f]/.test(value) &&
    /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|[1-8](?:st|nd|rd|th)?)[\s-]+year\b|\byear\s+[1-8]\b/i.test(value) &&
    /\b(?:bachelor|master|doctor|diploma|associate|mbbs|llb|llm|bba|bca|bms|bs|ba|be|bsc|bcom|btech|mtech|mba|mca|ma|ms|msc|b\.\s*(?:com|sc|tech|a|e)|m\.\s*(?:sc|tech|a))\b/i.test(value);
}

// Disclosure permits an omitted employer answer, never a published geographic
// restriction. A country list, required residency or work authorization still
// requires explicit verification instead of model inference.
export function permitsStatedIndiaLocation(job, policy) {
  if (policy?.applyWithStatedIndiaLocation !== true || policy.candidateCountry !== 'India' ||
      job?.track !== 'remote' || job.indiaEligible !== null ||
      !(job.remote === true || permitsStatedRemoteRequirement(job, policy)) || remoteWorkplaceConflict(job)) return false;
  const jd=job.jd, quote=job.evidence?.remote;
  if(typeof jd!=='string' || jd.length<100 || typeof quote!=='string' ||
      !(jd.includes(quote) || exactExcerptList(quote,jd)))return false;
  if(!/\bremote\b|work from (?:home|anywhere|wherever)|wherever you/i.test(quote))return false;
  const restricted=/\b(?:eligible|permitted|supported|approved|excluded|restricted)\s+(?:countries|locations|regions)\b|\b(?:countries|locations|regions)\s*(?:eligible|supported|only|:)|\b(?:must|need to|required to)\s+(?:be\s+)?(?:based|reside|live|located|authori[sz]ed|eligible)\b|\b(?:residency|residence|citizenship|work authori[sz]ation|right to work|work permit)\b|\b(?:only|exclusively)\s+(?:in|from|within|for)\s+[A-Z]|\b(?:US|USA|U\.S\.|UK|EU|EEA|Europe|Canada|Australia|India|United States|United Kingdom)[ -]only\b|\b(?:not|no)\s+(?:available|open|eligible|hiring)\s+(?:in|to|from)\b|\b(?:cannot|can't|do not|don't)\s+(?:hire|accept|employ|support)\b/i;
  const candidateGeography=/\b(?:candidates?|applicants?|employees?|interns?|hiring)\b[^.!?\n]{0,100}\b(?:based|located|residen\w*|citizen\w*|countries|country|within|outside|excluding|except)\b|\b(?:US|USA|UK|EU|EEA|Canada|Australia|Europe|American|European)[ -]based\b|\b(?:excluding|except|outside)\s+(?:India|Asia|South Asia)\b/i;
  return !restricted.test(jd) && !candidateGeography.test(jd);
}

function studentQualificationConflict(job) {
  // This exception handles omitted eligibility, not inferred equivalence to a
  // published qualification. Do not let source headings hide a restriction.
  const source=(String(job.jd || '')+' '+String(job.evidence?.studentEligible || '')).normalize('NFKC')
    .replace(/\b(?:any|all)\s+(?:(?:bachelor['’]?s?|undergraduate)\s+)?(?:degree|discipline|field|stream)s?\b/gi,' ')
    .replace(/\bno\s+(?:specific\s+)?(?:degree|qualification)s?\s+(?:is\s+|are\s+)?required\b|\bdegree\s+is\s+not\s+required\b/gi,' ');
  return /\b(?:graduates?|graduated|graduation|post[\s-]?graduate|post[\s-]?graduation|master['’]?s?|doctoral|ph\.?d\.?|mba|mca|bca|cse|b\.?\s?tech|m\.?\s?tech|b\.?\s?sc|m\.?\s?sc|bcom|b\.\s?com|bba|bachelor['’]?s?|degree|diploma)\b|\b(?:final|last|first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)[\s-]+year\b|\byear\s*[1-6]\b|\b(?:computer science|engineering|stem)\b[^.!?\n]{0,50}\b(?:students?|only|required|qualifications?)\b|\b(?:students?|background|pursuing|enrolled|qualifications?)\b[^.!?\n]{0,50}\b(?:computer science|engineering|stem)\b/i.test(source);
}

export function permitsStatedStudentStatus(job, policy) {
  const roleEvidence=job?.evidence?.role;
  return policy?.applyWithStatedStudentStatus===true && validStudentStatus(policy.studentStatus) && job?.studentEligible===null && typeof job.jd==='string' && job.jd.trim().length>=100 &&
    typeof roleEvidence==='string' && job.jd.includes(roleEvidence) && /\bintern(?:ship)?s?\b/i.test(roleEvidence) && !/\b(?:permanent|full[\s-]time)\s+(?:role|position|employment)\b/i.test(roleEvidence) && !studentQualificationConflict(job);
}

// A model extracts evidence. It cannot waive these gates or authorize an action.
export function assess(job, policy, today = dayInIndia()) {
  const missing = [], reject = [];
  if (!job || typeof job !== 'object') return { state: 'exception', reasons: ['Invalid evaluation'] };
  const track = policy.tracks[job.track];
  if (!track) missing.push('Unknown track');
  if (typeof job.jd !== 'string' || job.jd.trim().length < 100) missing.push('Full job description missing');
  if (job.active !== true) missing.push('Active posting not verified');
  const statedRemote = permitsStatedRemoteRequirement(job,policy);
  const statedStudent = permitsStatedStudentStatus(job,policy);
  const statedIndia = permitsStatedIndiaLocation(job,policy);
  if(policy.applyWithStatedStudentStatus===true && job.studentEligible===null && studentQualificationConflict(job))reject.push('Published student qualification requires explicit compatibility; status disclosure cannot waive it');
  if (policy.applyWithStatedRemoteRequirement === true && job.track === 'remote' && /\bremote[\s-]friendly\b/i.test(job.evidence?.remote || '')) {
    if (remoteWorkplaceConflict(job)) reject.push('Explicit workplace requirement conflicts with fully remote work');
    if (job.remote === true && !/\b(?:fully|100%)\s+remote\b/i.test(job.evidence.remote)) missing.push('Remote-friendly evidence does not establish fully remote work; keep employer remote unknown');
  }
  const optionalSchedule = key => policy.applyWithStatedAvailability === true && ['start','end','deadline','hours'].includes(key) && job[key] == null;
  for (const key of ['company', 'role', 'start', 'end', 'deadline', 'hours', 'indiaEligible', 'studentEligible', 'remote', 'duties', 'pay', 'fit']) {
    if (optionalSchedule(key) || (key === 'remote' && statedRemote) || (key === 'studentEligible' && statedStudent) || (key === 'indiaEligible' && statedIndia)) continue;
    if (job[key] === null || job[key] === undefined || job[key] === '') missing.push(`Missing ${key}`);
    else {
      const quote = job.evidence?.[key];
      // Undisclosed pay records an unknown, rather than an employer promise.
      // Any supplied quotation must still be checked against the posting.
      if (key === 'pay' && job.pay === 'undisclosed' && quote == null) continue;
      if (typeof quote !== 'string' || quote.trim().length < 3 || (!job.jd?.includes(quote) && !(['fit','duties','remote'].includes(key) && exactExcerptList(quote,job.jd)))) missing.push(`Unverified ${key} evidence`);
    }
  }
  for (const key of ['start', 'end', 'deadline']) if (!optionalSchedule(key) && !validDate(job[key])) missing.push(`Invalid ${key}`);
  if (validDate(job.deadline) && job.deadline < today) reject.push('Application deadline passed');
  if (job.indiaEligible === false) reject.push('Not eligible from India');
  if (job.studentEligible === false) reject.push('Student requirements incompatible');
  if ((typeof job.indiaEligible !== 'boolean' && !statedIndia) || (typeof job.studentEligible !== 'boolean' && !statedStudent) || (typeof job.remote !== 'boolean' && !statedRemote)) missing.push('Eligibility requires explicit booleans');
  if (!optionalSchedule('hours') && (!Number.isFinite(job.hours) || job.hours <= 0)) missing.push('Invalid hours');
  if (job.durationMonths != null) {
    const durationIssues=quantifiedEvidenceIssues(job,policy).filter(issue=>issue.startsWith('Duration in months'));
    missing.push(...durationIssues);
  }
  if (!Number.isFinite(job.fit) || job.fit < 0 || job.fit > 5) missing.push('Invalid fit');
  if (!['substantive', 'excluded'].includes(job.duties)) missing.push('Duties not classified');
  if (job.duties === 'excluded') reject.push('Sales, lead generation or routine marketing dominated duties');
  if (!['paid', 'unpaid', 'undisclosed'].includes(job.pay)) missing.push('Pay not classified');
  if (track) {
    if (track.latest_end < today) reject.push('Track window closed');
    const earliest = track.earliest_start === 'immediate' ? today : track.earliest_start;
    if ((validDate(job.start) && (job.start < today || job.start < earliest || job.start > track.latest_end)) ||
        (validDate(job.end) && (job.end < today || job.end < earliest || job.end > track.latest_end)) ||
        (validDate(job.start) && validDate(job.end) && job.end < job.start)) reject.push('Dates outside availability');
    if (validDate(job.start) && validDate(job.end)) {
      const limit = new Date(`${job.start}T00:00:00Z`);
      limit.setUTCMonth(limit.getUTCMonth() + track.max_months);
      if (new Date(job.end) >= limit) reject.push('Duration exceeds track maximum');
    }
    if (job.hours > track.max_hours_per_week) reject.push('Hours exceed availability');
    if (Number.isFinite(job.durationMonths) && job.durationMonths > track.max_months) reject.push('Duration exceeds track maximum');
    if (job.track === 'remote' && job.remote === false) reject.push('Remote track requires fully remote');
    if (job.remote === false && job.country !== 'India') reject.push('On-site must be in India');
    if (job.remote === false && (!job.evidence?.country || !job.jd?.includes(job.evidence.country))) missing.push('On-site country unverified');
  }
  if (job.pay === 'unpaid') {
    if (Number.isFinite(job.fit) && job.fit < policy.unpaidFit) reject.push('Unpaid fit below threshold');
    for (const key of ['credibleEmployer', 'project', 'supervision']) if (job[key] !== true || !job.evidence?.[key] || !job.jd?.includes(job.evidence[key])) missing.push(`Unpaid ${key} evidence required`);
  } else if (Number.isFinite(job.fit) && job.fit < policy.minimumFit) reject.push('Fit below threshold');
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
