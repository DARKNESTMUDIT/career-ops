// Conservative reject-only triage for Internshala's exact captured JobPosting
// JSON-LD description. No navigation, title, employer blurb, or other section
// can trigger a decision. Null means the evaluator must read the posting.
const OPEN='Internshala exact-posting JobPosting JSON-LD description (independent source section; retain any differences from body text):\n';
const CLOSE='\n\nInternshala exact-posting JobPosting JSON-LD metadata (verbatim values; country codes are provider data):\n';
const HEADINGS=[
  /^Selected intern['’]s day-to-day responsibilities include:\s*$/i,
  /^Day-to-Day Responsibilities:?\s*$/i,
];
const STOP=/^(?:Who can apply|Only those candidates can apply|Skill\(s\) required|Skills required|Perks|Other requirements|Stipend|Salary|About (?:the )?company|Additional information|Number of openings|Deadline|Benefits)\b/i;
const NEGATION=/\b(?:no|not|never|without|avoid|excluding|rather than|instead of|do not|don't|won't)\b.{0,55}\b(?:cold.call(?:s|ing)?|telemarketing|outbound|bulk.email|lead.gen|direct.sales|clos(?:e|ing) deals?)\b/i;
const STRATEGIC=/\b(?:market research|user research|product research|customer research|competitive research|strategy|strategic|analytics?|analys(?:is|e|ing)|experiments?|product features?|user experience|stakeholders?|roadmap|planning|design|partnerships?|requirements?|feasibility|governance|risk assessment|project management)\b/i;
const SALES=[
  {kind:'cold calling', pattern:/\b(?:make|perform|conduct|do|handle|carry out|execute|place|initiate)\s+(?:daily\s+|regular\s+|outbound\s+)?cold[ -]?calls?\b|\bcold[ -]?call(?:ing)?\s+(?:prospects?|customers?|leads?)\b/i},
  {kind:'telemarketing', pattern:/\b(?:perform|conduct|do|handle|execute|manage|run)\s+telemarketing\b|\btelemarket(?:ing)?\s+(?:to|for|prospects?|customers?|leads?)\b/i},
  {kind:'bulk outbound email', pattern:/\b(?:send|run|execute|manage|conduct|perform)\s+(?:(?:bulk|mass|cold|outbound)\s+){1,3}(?:email|emails|emailing|email campaigns?)\b|\bemail\s+(?:hundreds|thousands)\s+of\s+(?:prospects?|leads?)\b/i},
  {kind:'lead generation', pattern:/\b(?:generate|source|qualify|prospect|capture|acquire)\s+(?:(?:new|sales|business|qualified)\s+){0,3}leads?\b|\b(?:perform|conduct|do|execute|manage|drive|run)\s+lead[ -]?generation\b/i},
  {kind:'direct sales', pattern:/\b(?:sell|pitch|upsell|cross[ -]?sell)\s+(?:products?|services?|plans?|subscriptions?)\s+(?:to\s+)?(?:prospects?|customers?|clients?|leads?)\b|\b(?:perform|conduct|do|execute|drive|handle)\s+direct[ -]?sales\b/i},
  {kind:'closing deals', pattern:/\b(?:close|closing|finali[sz]e)\s+(?:(?:sales|customer)\s+)?(?:deals|transactions|orders)\b|\b(?:close|closing|finali[sz]e)\s+sales\b|\bconvert\s+(?:prospects?|leads?)\s+into\s+(?:sales|paying customers?)\b/i},
];
const NEUTRAL=/^(?:maintain|update|record|prepare|submit|report|track|log)\b.{0,140}\b(?:sales activity|call logs?|crm records?|sales metrics?|daily sales reports?)\b/i;

function structuredDescription(capture) {
  if (capture?.method !== 'internshala-public-html-and-jsonld' || typeof capture.text !== 'string') return null;
  const start=capture.text.indexOf(OPEN);
  if (start<0 || capture.text.indexOf(OPEN,start+OPEN.length)>=0) return null;
  const end=capture.text.indexOf(CLOSE,start+OPEN.length);
  if (end<0 || capture.text.indexOf(CLOSE,end+CLOSE.length)>=0) return null;
  const section=capture.text.slice(start+OPEN.length,end);
  return section.length>0 && section.length<40000 ? section : null;
}

function dutyBullets(description) {
  const lines=description.split(/\r?\n/);
  const headingIndexes=lines.map((line,index)=>HEADINGS.some(re=>re.test(line.trim()))?index:-1).filter(index=>index>=0);
  if (headingIndexes.length!==1) return null;
  const after=lines.slice(headingIndexes[0]+1);
  const bullets=[];
  let current=null, stopped=false;
  for(const raw of after) {
    const line=raw.trim();
    if(STOP.test(line)) { stopped=true; break; }
    if(!line) continue;
    const numbered=/^(\d{1,2})\.\s*(.+)$/.exec(line);
    if(numbered) {
      if(Number(numbered[1])!==bullets.length+1) return null;
      current=numbered[2].trim();bullets.push(current);
    } else if(current!==null) {
      // Multiline numbered prose introduces ambiguous scope. No decision.
      return null;
    } else return null;
  }
  if(!stopped || bullets.length<3 || bullets.length>20 || bullets.some(b=>b.length<12 || b.length>500)) return null;
  return bullets;
}

export function triageInternshalaSalesDuties(capture) {
  const description=structuredDescription(capture);
  if(!description)return null;
  const bullets=dutyBullets(description);
  if(!bullets)return null;
  const matches=[];let neutral=0;
  for(const quote of bullets) {
    if(NEGATION.test(quote) || STRATEGIC.test(quote))return null;
    const kinds=SALES.filter(rule=>rule.pattern.test(quote)).map(rule=>rule.kind);
    if(kinds.length) matches.push({quote,kinds});
    else if(NEUTRAL.test(quote))neutral++;
    else return null;
  }
  if(matches.length<3 || !(matches.length===bullets.length || (matches.length/bullets.length>2/3 && neutral===bullets.length-matches.length))) return null;
  return {
    decision:'excluded',
    reason:`${matches.length} of ${bullets.length} explicit duties are cold calling, telemarketing, bulk outbound email, lead generation, direct sales, or closing deals; no strategic or ambiguous duty appears in the recognized responsibilities list.`,
    source:'Internshala JobPosting JSON-LD description > day-to-day responsibilities',
    quotes:matches,
  };
}
