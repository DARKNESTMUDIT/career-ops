// Queue ordering only: these title signals do not establish eligibility or fit.
// Target vocabulary comes exclusively from the approved profile.
const generic = new Set(['a','an','and','at','by','for','from','in','of','on','or','s','the','to','with','intern','interns','internship','internships','trainee','trainees','role','roles','job','jobs','career','careers','application','applications','apply','opening','openings','position','positions','office','substantive','primary','secondary','junior','senior','remote','hybrid','onsite','full','part','time']);
function tokens(value) {
  if (typeof value !== 'string') return new Set();
  const words=value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return new Set(words.filter(word=>!generic.has(word) && !/^\d+$/.test(word)).map(word=>{
    // Common title inflections; no vocabulary here adds a target preference.
    if (/^strateg(?:y|ies|ic|ist|ists)$/.test(word)) return 'strategy';
    if (/^consult(?:ing|ant|ants|ancy)?$/.test(word)) return 'consult';
    if (/^research(?:er|ers|ing)?$/.test(word)) return 'research';
    if (/^founder(?:s)?$/.test(word)) return 'founder';
    if (/^engineer(?:s|ing)?$/.test(word)) return 'engineer';
    if (/^develop(?:er|ers|ing|ment)?$/.test(word)) return 'develop';
    if (/^manag(?:e|er|ers|ing|ement)$/.test(word)) return 'manage';
    return word.length>4 && word.endsWith('s') ? word.slice(0,-1) : word;
  }));
}
function pathTitle(url) {
  if (typeof url !== 'string') return '';
  try { return decodeURIComponent(new URL(url).pathname); }
  catch { return ''; }
}
function profileTokens(values) {
  return new Set(values.flatMap(value=>[...tokens(value)]));
}

export function prioritizeForProfile(jobs,profile) {
  const primary=profile?.target_roles?.primary;
  const archetypes=profile?.target_roles?.archetypes;
  const main=profileTokens(Array.isArray(primary)?primary:[]);
  const secondary=profileTokens(Array.isArray(archetypes)?archetypes.map(item=>typeof item==='string'?item:item?.name):[]);
  if (!main.size && !secondary.size) return [...jobs];
  const score=job=>{
    const signals=tokens(`${typeof job?.payload?.role==='string'?job.payload.role:''} ${pathTitle(job?.url)}`);
    let value=0;
    for (const term of signals) value+=main.has(term)?2:secondary.has(term)?1:0;
    return value;
  };
  // Explicit input index keeps ties deterministic and preserves prior queue policy.
  return jobs.map((job,index)=>({job,index,score:score(job)}))
    .sort((a,b)=>b.score-a.score || a.index-b.index).map(item=>item.job);
}
