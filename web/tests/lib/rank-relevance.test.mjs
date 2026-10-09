import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roleScore,
  locationScore,
  freshnessScore,
  relevanceScore,
  compareRelevance,
  TIER_WEIGHT,
  MAX_LOCATION,
} from '../../src/lib/rank-relevance.mjs';

test('primary archetypes outrank secondary and adjacent', () => {
  assert.equal(roleScore("Founder's Office Internship").tier, 'primary');
  assert.equal(roleScore('Chief of Staff').tier, 'primary');
  assert.equal(roleScore('Business Strategy Internship').tier, 'primary');
  assert.equal(roleScore('Business Analyst Internship').tier, 'primary');

  assert.equal(roleScore('Market Research Internship').tier, 'secondary');
  assert.equal(roleScore('Product Management Internship').tier, 'secondary');
  assert.equal(roleScore('Equity Research Internship').tier, 'secondary');

  assert.equal(roleScore('Growth Internship').tier, 'adjacent');
  assert.equal(roleScore('Operations Internship').tier, 'adjacent');

  assert.ok(TIER_WEIGHT.primary > TIER_WEIGHT.secondary);
  assert.ok(TIER_WEIGHT.secondary > TIER_WEIGHT.adjacent);
});

test('a title matching several tiers takes the highest', () => {
  // "Marketplace Strategy & Operations" hits primary (strategy) and adjacent
  // (operations); primary must win.
  const r = roleScore('Marketplace Strategy & Operations Internship');
  assert.equal(r.tier, 'primary');
  assert.equal(r.score, TIER_WEIGHT.primary);
});

test('unrelated titles score zero on role', () => {
  assert.equal(roleScore('Video Editing Internship').score, 0);
  assert.equal(roleScore('Telecalling Internship').score, 0);
  assert.equal(roleScore('').score, 0);
  assert.equal(roleScore(undefined).score, 0);
});

test('location fit follows the two-track window', () => {
  assert.equal(locationScore('Work from home'), MAX_LOCATION);
  assert.equal(locationScore('Remote'), MAX_LOCATION);
  assert.ok(locationScore('Ghaziabad') > locationScore('Bangalore'));
  assert.ok(locationScore('Delhi, Remote') === MAX_LOCATION); // remote wins when both present
  assert.ok(locationScore('Mumbai') > 0);
  // No location claim is neither rewarded nor punished.
  assert.equal(locationScore(''), 0);
  assert.equal(locationScore(null), 0);
});

test('freshness decays to zero at 30 days and never goes negative', () => {
  assert.ok(freshnessScore(0) > freshnessScore(10));
  assert.ok(freshnessScore(10) > freshnessScore(29));
  assert.equal(freshnessScore(30), 0);
  assert.equal(freshnessScore(400), 0);
  assert.equal(freshnessScore(null), 0);
});

test('a remote primary role outranks a fresher irrelevant one', () => {
  const good = { job: { role: "Founder's Office Internship", location: 'Remote', company: 'Acme AI' }, age: 20 };
  const noise = { job: { role: 'Video Editing Internship', location: 'Remote', company: 'Studio' }, age: 0 };
  assert.ok(compareRelevance(good, noise) < 0, 'relevant role must sort first');
});

test('among equally relevant roles, the fresher one wins', () => {
  const older = { job: { role: 'Strategy Internship', location: 'Remote', company: 'X' }, age: 20 };
  const newer = { job: { role: 'Strategy Internship', location: 'Remote', company: 'X' }, age: 1 };
  assert.ok(compareRelevance(newer, older) < 0);
});

test('location genuinely moves ranking between same-tier roles', () => {
  const remote = { job: { role: 'Strategy Internship', location: 'Remote' }, age: 5 };
  const metro = { job: { role: 'Strategy Internship', location: 'Mumbai' }, age: 5 };
  assert.ok(compareRelevance(remote, metro) < 0);
});

test("Founder's Office outranks generic consulting even with a domain bonus against it", () => {
  // Regression: flat primary weights let "+8 domain" push a Security Consultant
  // role at an infosec firm above a real Founder's Office posting.
  const founders = { job: { role: "Founders Office Internship", location: 'Work from home', company: 'Creative Banyan' }, age: 0 };
  const security = { job: { role: 'Security Consultant Internship', location: 'Bangalore, Remote', company: 'CloudSEK' }, age: 0 };
  assert.ok(compareRelevance(founders, security) < 0, "Founder's Office must outrank Security Consultant");
});

test('archetype ordering within primary follows profile priority', () => {
  const fo = roleScore("Founder's Office Internship").score;
  const ai = roleScore('AI Product Strategy Internship').score;
  const ba = roleScore('Business Analyst Internship').score;
  const consult = roleScore('Technology Consulting Internship').score;
  assert.ok(fo > ai && ai > ba && ba > consult, `expected FO>AI>BA>consulting, got ${fo}/${ai}/${ba}/${consult}`);
  assert.ok(consult >= TIER_WEIGHT.primary);
});

test('relevanceScore exposes its component parts', () => {
  const r = relevanceScore({ role: "Founder's Office Internship", location: 'Remote', company: 'Acme AI' }, 0);
  assert.ok(r.parts.role >= TIER_WEIGHT.primary);
  assert.equal(r.parts.location, MAX_LOCATION);
  assert.ok(r.parts.domain > 0);
  assert.equal(r.score, r.parts.role + r.parts.location + r.parts.freshness + r.parts.domain);
});
