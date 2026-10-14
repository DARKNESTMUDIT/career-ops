import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prioritize, pendingWork } from '../autonomous/rollout.mjs';

const job = (id, updated, track = null, payload = {}, state = 'discovered') => ({id, updated, track, payload, state});
const ids = jobs => jobs.map(j => j.id);

test('unenriched discovery prefers fresh postings with deterministic ties', () => {
  const old = job('old','2026-10-01'), fresh = job('fresh','2026-10-14');
  const a = job('a','2026-10-13'), b = job('b','2026-10-13');
  assert.deepEqual(ids(prioritize([old,b,fresh,a])),['fresh','a','b','old']);
});

test('explicit deadlines and fit retain priority over discovery recency', () => {
  const jobs = [job('fresh','2026-10-14','remote'),job('later','2026-10-14','remote',{deadline:'2026-11-01',fit:5}),job('low','2026-10-14','remote',{deadline:'2026-10-20',fit:4}),job('high','2026-10-01','remote',{deadline:'2026-10-20',fit:5})];
  assert.deepEqual(ids(prioritize(jobs)),['high','low','later','fresh']);
});

test('known tracks and unclassified discovery alternate without starvation', () => {
  const jobs = [job('remote-old','2026-10-01','remote'),job('summer-old','2026-10-01','summer'),job('unknown-old','2026-10-01'),job('remote-new','2026-10-14','remote'),job('summer-new','2026-10-14','summer'),job('unknown-new','2026-10-14')];
  assert.deepEqual(ids(prioritize(jobs)),['remote-new','summer-new','unknown-new','remote-old','summer-old','unknown-old']);
});

test('ready freshness checks interleave with fresh discovery', () => {
  const jobs = [job('old','2026-10-01'),job('fresh','2026-10-14'),job('ready-later','2026-10-13','remote',{deadline:'2026-11-01',fit:5},'ready'),job('ready-first','2026-10-13','remote',{deadline:'2026-10-20',fit:4},'ready')];
  assert.deepEqual(ids(pendingWork(jobs)),['fresh','ready-first','old','ready-later']);
});

test('mixed rank ties have a transitive fixed category and stable identity order', () => {
  const jobs = [job('raw-old','2026-10-01'),job('prepared','2026-10-10',null,{},'prepared'),job('raw-new','2026-10-14')];
  for (const order of [jobs,[jobs[2],jobs[0],jobs[1]],[jobs[1],jobs[2],jobs[0]]]) {
    assert.deepEqual(ids(prioritize(order)),['prepared','raw-new','raw-old']);
  }
});
