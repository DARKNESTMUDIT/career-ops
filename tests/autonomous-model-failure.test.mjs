import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plannerFailure,planJSON} from '../autonomous/model.mjs';
import {EventEmitter} from 'node:events';
test('usage and authentication failures take precedence over an eventual timeout',()=>{
  for(const message of ['You have hit your usage limit.','Usage limit reached','Rate limit exceeded','insufficient_quota','rate_limit_exceeded','invalid_api_key','Authentication expired','Please sign in','unexpected status 401 Unauthorized','HTTP 403','status code: 429'])assert.match(plannerFailure(message,{killed:true}).message,/^Model usage\/authentication unavailable/,message);
});
test('CLI quota cause survives later reconnect output and process timeout without a real model call',async()=>{
  let spawned=0;
  const spawnProcess=()=>{
    spawned++;const child=new EventEmitter();
    child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.stdin.end=()=>{child.stderr.emit('data',Buffer.from('HTTP 429 quota exhausted\n'));child.stderr.emit('data',Buffer.from('reconnecting after stream disconnect\n'.repeat(100)));};
    child.kill=()=>child.emit('close',null);
    return child;
  };
  await assert.rejects(planJSON('Synthetic fixture only',undefined,50,process.env,{spawnProcess}),error=>error.message==='Model usage/authentication unavailable (HTTP 429)');
  assert.equal(spawned,1);
});
test('actual timeouts preserve bounded sanitized connection diagnostics without raw error text',()=>{
  const error=plannerFailure('reconnecting: stream disconnected. PRIVATE_PAYLOAD',{killed:true});
  assert.equal(error.message,'Model timeout (connection retries observed)');assert.ok(!error.message.includes('PRIVATE_PAYLOAD'));
  assert.equal(plannerFailure('',{killed:true}).message,'Model timeout');
  assert.equal(plannerFailure('unrelated warning',{code:2}).message,'Model failed (2)');
});
