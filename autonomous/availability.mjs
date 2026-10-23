import { permitsStatedRemoteRequirement, validStudentStatus } from './policy.mjs';

const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const bounded = (value, maximum) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maximum;

// These are candidate limits from primary profile configuration. An extracted
// posting may select a track, but cannot supply or overwrite any availability.
export function availabilityDisclosure(context, job) {
  const remoteRequirement=[remoteRequirementDisclosure(context,job),studentStatusDisclosure(context,job)].filter(Boolean).join('\n\n');
  if (context?.policy?.applyWithStatedAvailability !== true) return remoteRequirement;
  const track = job?.track;
  if (!['remote','summer'].includes(track)) throw new Error('Valid candidate availability track required');
  const configured = context?.profile?.availability?.[track];
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error('Primary candidate availability configuration required');
  const {earliest_start:start,latest_end:end,max_months:months,max_hours_per_week:hours,workplace} = configured;
  if ((start !== 'immediate' && !isoDate(start)) || !isoDate(end) ||
      (start !== 'immediate' && start > end) || !bounded(months,12) || !bounded(hours,168) ||
      typeof workplace !== 'string' || !workplace.trim() || /[\r\n\u0000-\u001f\u007f]/.test(workplace)) {
    throw new Error('Primary candidate availability configuration is malformed');
  }
  return `${remoteRequirement ? remoteRequirement+'\n\n' : ''}My availability is ${workplace.trim()}, starting ${start === 'immediate' ? 'immediately' : start}, for up to ${months} months, ending no later than ${end}, and up to ${hours} hours per week. These are my candidate availability limits; they are not an employer-confirmed schedule. Please confirm whether the role can accommodate this availability.`;
}

export function remoteRequirementDisclosure(context, job) {
  if (!permitsStatedRemoteRequirement(job,context?.policy)) return '';
  return 'I require a fully remote arrangement from India. The posting describes the role as remote-friendly; whether it supports fully remote work from India is not employer-confirmed. Please confirm this requirement can be accommodated.';
}

export function studentStatusDisclosure(context, job) {
  if(context?.policy?.applyWithStatedStudentStatus!==true || job?.studentEligible!==null)return '';
  const status=context?.profile?.application_disclosures?.student_status;
  if(!validStudentStatus(status) || status!==context.policy.studentStatus)throw new Error('Primary student status disclosure is missing or changed');
  return `My current student status: ${status}. The posting does not confirm eligibility for my degree and year. Please confirm whether my current student status is suitable.`;
}

// Only express a learning aspiration. Never transform targeting/narrative into
// a claim of prior product work or reuse unverified numbers from that narrative.
export function productMotivation(context) {
  const primary = context?.profile?.target_roles?.primary;
  const exitStory = context?.profile?.narrative?.exit_story;
  if (!Array.isArray(primary) || !primary.some(role => typeof role === 'string' && /\bproduct\b/i.test(role)) ||
      typeof exitStory !== 'string' || !/\bproduct\b/i.test(exitStory)) return '';
  return 'I am interested in product work and hope to learn more about product discovery and prioritization through this opportunity.';
}
