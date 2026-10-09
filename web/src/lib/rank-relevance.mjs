/**
 * rank-relevance.mjs — relevance ranking for the inbox triage list.
 *
 * The inbox originally ordered by freshness alone. That is the right default
 * for a small inbox and the wrong one for a large one: at 400+ rows the newest
 * posting is rarely the best one, and the roles that actually fit sink out of
 * the first screen.
 *
 * This module is the "smarter ranker" the plug point in `inbox-triage.tsx`
 * anticipates. It replaces ONLY the comparator — facets, triage, shortlist and
 * the evaluation score are untouched, so nothing here can affect what a role
 * scores once it is properly evaluated by the agent. This is a cheap,
 * deterministic pre-sort over title/location/age, not a judgement.
 *
 * It is intentionally zero-token and synchronous: it runs in the browser over
 * the whole inbox on every render, so it must stay cheap.
 *
 * ── Coupling note ────────────────────────────────────────────────────────
 * ROLE_TIERS mirrors `target_roles.archetypes` in `config/profile.yml`, and
 * the tier weights mirror that block's `fit:` values (primary / secondary /
 * adjacent). profile.yml stays the source of truth for WHAT is wanted; this
 * table supplies the vocabulary those archetypes actually appear under in real
 * job titles ("BizOps" for Business Analyst, "Chief of Staff" for Founder's
 * Office, and so on), which a name alone does not give. If the archetypes in
 * profile.yml change, update this table to match.
 */

/** Tier weights, mirroring `fit:` in config/profile.yml → target_roles.archetypes. */
export const TIER_WEIGHT = { primary: 100, secondary: 60, adjacent: 30 };

/**
 * Title vocabulary per archetype. A title may match several entries — the
 * highest scoring one is used (see roleScore).
 *
 * `weight` overrides the tier default. It exists because "primary" is not flat:
 * profile.yml lists Founder's Office and AI Product Strategy first among the
 * primaries, and a flat 100 let the +8 domain bonus rank "Security Consultant
 * Internship" (a `consult` match at an infosec firm) above a real Founder's
 * Office posting. The spread here keeps the archetype ordering dominant over
 * any bonus.
 */
export const ROLE_TIERS = [
  {
    tier: 'primary',
    weight: 115,
    archetype: "Founder's Office / Chief of Staff",
    patterns: [/founder'?s?\s*office/i, /chief of staff/i, /founding\s+(team|associate)/i],
  },
  {
    tier: 'primary',
    weight: 110,
    archetype: 'AI Product Strategy / AI Research',
    patterns: [/\bai\b.*(strategy|research|product|analyst)/i, /(strategy|research|product).*\bai\b/i, /prompt engineer/i],
  },
  {
    tier: 'primary',
    weight: 105,
    archetype: 'Business Analyst',
    patterns: [/business analyst/i, /\bbizops\b/i, /business operations/i],
  },
  {
    tier: 'primary',
    archetype: 'Strategy & Management Consulting',
    patterns: [/\bstrateg(y|ic|ist)\b/i, /consult(ing|ant)/i, /\badvisory\b/i],
  },
  {
    tier: 'secondary',
    archetype: 'Business / Market Research',
    patterns: [/market research/i, /\bresearch\b/i, /\binsights?\b/i, /competitive intelligence/i],
  },
  {
    tier: 'secondary',
    archetype: 'Product Management',
    patterns: [/product manage(ment|r)/i, /\bproduct\b/i, /\bapm\b/i],
  },
  {
    tier: 'secondary',
    archetype: 'Investment / Equity Research',
    patterns: [/equity research/i, /investment (research|banking|analyst)/i, /\bfinancial? analyst\b/i, /\bfinance\b/i],
  },
  {
    tier: 'adjacent',
    archetype: 'Venture Capital',
    patterns: [/venture capital/i, /\bvc\b/i, /private equity/i, /deal (sourcing|flow)/i],
  },
  {
    tier: 'adjacent',
    archetype: 'Growth / GTM',
    patterns: [/\bgrowth\b/i, /\bgtm\b/i, /go.to.market/i, /partnerships?/i, /\bbrand\b/i, /\bmarketing\b/i],
  },
  {
    tier: 'adjacent',
    archetype: 'General operations',
    patterns: [/\boperations?\b/i, /\banalytics?\b/i, /\bproject\b/i, /\bprogram\b/i],
  },
];

/** Domain words that signal the kind of company he is targeting. */
const DOMAIN_BONUS = /\b(ai|saas|fintech|consult\w*|capital|ventures?|advisory|research|analytics|strategy)\b/i;

export const MAX_LOCATION = 40;
export const MAX_FRESHNESS = 15;
export const MAX_DOMAIN = 8;

/**
 * Best archetype match for a title.
 * @returns {{score:number, tier:string|null, archetype:string|null}}
 */
export function roleScore(title) {
  const t = String(title || '');
  let best = { score: 0, tier: null, archetype: null };
  for (const entry of ROLE_TIERS) {
    const weight = entry.weight ?? TIER_WEIGHT[entry.tier] ?? 0;
    if (weight <= best.score) continue; // cannot beat what we have
    if (entry.patterns.some((re) => re.test(t))) {
      best = { score: weight, tier: entry.tier, archetype: entry.archetype };
    }
  }
  return best;
}

/**
 * Location fit against the two-track window in modes/_profile.md: remote is
 * worth most (Track A, runnable during term), Delhi NCR next (commutable),
 * other Indian metros least (Track B / summer 2027 only).
 */
export function locationScore(location) {
  const l = String(location || '').toLowerCase();
  if (!l) return 0; // no claim either way — don't reward or punish
  if (/remote|work from home|wfh|anywhere|worldwide/.test(l)) return MAX_LOCATION;
  if (/delhi|gurugram|gurgaon|noida|ghaziabad|faridabad|\bncr\b/.test(l)) return 35;
  if (/hybrid/.test(l)) return 15;
  if (/bengaluru|bangalore|mumbai|hyderabad|pune|chennai|kolkata|india/.test(l)) return 8;
  return 0;
}

/** Newest scores highest, decaying linearly to zero at 30 days. */
export function freshnessScore(ageDays) {
  if (ageDays == null || !Number.isFinite(ageDays)) return 0;
  const clamped = Math.max(0, Math.min(30, ageDays));
  return Math.round(((30 - clamped) / 30) * MAX_FRESHNESS);
}

/**
 * Total relevance for one inbox row.
 *
 * @param {{role?:string, company?:string, location?:string}} job
 * @param {number|null} ageDays
 * @returns {{score:number, tier:string|null, archetype:string|null, parts:object}}
 */
export function relevanceScore(job, ageDays) {
  const role = roleScore(job?.role);
  const loc = locationScore(job?.location);
  const fresh = freshnessScore(ageDays);
  const domain = DOMAIN_BONUS.test(`${job?.role || ''} ${job?.company || ''}`) ? MAX_DOMAIN : 0;
  return {
    score: role.score + loc + fresh + domain,
    tier: role.tier,
    archetype: role.archetype,
    parts: { role: role.score, location: loc, freshness: fresh, domain },
  };
}

/**
 * Comparator for the triage list: relevance desc, then freshness as the
 * tie-break so equally-relevant roles still surface newest-first.
 *
 * @param {{job:object, age:number|null}} a
 * @param {{job:object, age:number|null}} b
 */
export function compareRelevance(a, b) {
  const sa = relevanceScore(a.job, a.age).score;
  const sb = relevanceScore(b.job, b.age).score;
  if (sb !== sa) return sb - sa;
  return (a.age ?? Infinity) - (b.age ?? Infinity);
}
