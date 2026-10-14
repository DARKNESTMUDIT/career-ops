import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelSelection, planJSON } from '../autonomous/model.mjs';

const config = 'model = "configured-model"\nmodel_reasoning_effort = "high"\n[mcp_servers.example]\nmodel = "ignored-model"';

test('unset planner overrides preserve top-level configured selection', () => {
  assert.deepEqual(modelSelection(config, {}), ['-c', 'model="configured-model"', '-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(modelSelection('', {}), []);
});

test('project planner overrides win once without duplicate model options', () => {
  const args = modelSelection(config, {
    CAREER_OPS_PLANNER_MODEL: 'gpt-6.1-sol',
    CAREER_OPS_PLANNER_REASONING_EFFORT: 'low',
  });
  assert.deepEqual(args, ['-c', 'model="gpt-6.1-sol"', '-c', 'model_reasoning_effort="low"']);
  assert.equal(args.filter(value => value.startsWith('model=')).length, 1);
  assert.equal(args.filter(value => value.startsWith('model_reasoning_effort=')).length, 1);
});

test('each planner override independently preserves the other configured value', () => {
  assert.deepEqual(modelSelection(config, { CAREER_OPS_PLANNER_MODEL: 'gpt-6-luna' }), ['-c', 'model="gpt-6-luna"', '-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(modelSelection(config, { CAREER_OPS_PLANNER_REASONING_EFFORT: 'medium' }), ['-c', 'model="configured-model"', '-c', 'model_reasoning_effort="medium"']);
});

test('planner rejects empty, unsafe or malformed model and effort overrides', () => {
  for (const model of ['', '-model', 'model name', 'model"\nfoo=true', 'model/provider', 'a'.repeat(129), null, 5]) {
    assert.throws(() => modelSelection(config, { CAREER_OPS_PLANNER_MODEL: model }), /Invalid CAREER_OPS_PLANNER_MODEL/);
  }
  for (const effort of ['', 'automatic', 'LOW', 'low"\nfoo=true', null, 5]) {
    assert.throws(() => modelSelection(config, { CAREER_OPS_PLANNER_REASONING_EFFORT: effort }), /Invalid CAREER_OPS_PLANNER_REASONING_EFFORT/);
  }
});

test('planJSON rejects invalid overrides before attempting any model call', async () => {
  await assert.rejects(planJSON('unused', undefined, undefined, { CAREER_OPS_PLANNER_MODEL: 'invalid model' }), /Invalid CAREER_OPS_PLANNER_MODEL/);
  await assert.rejects(planJSON('unused', undefined, undefined, { CAREER_OPS_PLANNER_REASONING_EFFORT: 'invalid' }), /Invalid CAREER_OPS_PLANNER_REASONING_EFFORT/);
});
