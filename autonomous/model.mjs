import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const evaluationSchema = {
  type: 'object', additionalProperties: false,
  properties: Object.fromEntries([
    ...['company','role','track','start','end','deadline','country','duties','pay','reason'].map(k => [k, { type: ['string','null'] }]),
    ...['hours','fit','durationMonths'].map(k => [k, { type: ['number','null'] }]),
    ...['indiaEligible','studentEligible','remote','credibleEmployer','project','supervision'].map(k => [k, { type: ['boolean','null'] }]),
    ['track',{type:['string','null'],enum:['remote','summer',null]}],
    ['duties',{type:['string','null'],enum:['substantive','excluded',null]}],
    ['pay',{type:['string','null'],enum:['paid','unpaid','undisclosed',null]}],
    ['evidence', { type: 'object', additionalProperties: false, properties: Object.fromEntries(['company','role','start','end','deadline','country','hours','durationMonths','indiaEligible','studentEligible','remote','duties','pay','fit','credibleEmployer','project','supervision'].map(k => [k, { type: ['string','null'] }])), required: ['company','role','start','end','deadline','country','hours','durationMonths','indiaEligible','studentEligible','remote','duties','pay','fit','credibleEmployer','project','supervision'] }],
  ]),
  required: ['company','role','track','start','end','deadline','country','duties','pay','reason','hours','fit','durationMonths','indiaEligible','studentEligible','remote','credibleEmployer','project','supervision','evidence'],
};

// Dedicated no-tools planner: auth stays in CODEX_HOME, but plugins/MCP/hooks are
// not loaded. Preserve only the explicitly configured model and reasoning effort.
export function modelSelection(config = '', env = process.env) {
  const top = config.split(/^\[/m)[0];
  const overrides = {
    model: env.CAREER_OPS_PLANNER_MODEL,
    model_reasoning_effort: env.CAREER_OPS_PLANNER_REASONING_EFFORT,
  };
  if (overrides.model !== undefined && (typeof overrides.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(overrides.model))) {
    throw new Error('Invalid CAREER_OPS_PLANNER_MODEL: use a model identifier with letters, digits, dots, underscores or hyphens');
  }
  if (overrides.model_reasoning_effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(overrides.model_reasoning_effort)) {
    throw new Error('Invalid CAREER_OPS_PLANNER_REASONING_EFFORT');
  }
  return ['model', 'model_reasoning_effort'].flatMap(k => {
    if (overrides[k] !== undefined) return ['-c', `${k}=${JSON.stringify(overrides[k])}`];
    const m = top.match(new RegExp(`^${k}\\s*=\\s*("[^"\\n]+")\\s*$`, 'm'));
    return m ? ['-c', `${k}=${m[1]}`] : [];
  });
}
export function configuredPlannerModel(env = process.env) {
  const configPath = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const selection = modelSelection(config, env);
  const model = selection.find(value => value.startsWith('model='));
  return model ? JSON.parse(model.slice('model='.length)) : null;
}

export function planWithSolFallback(prompt) {
  return planJSON(prompt, evaluationSchema, 180000, {
    ...process.env,
    CAREER_OPS_PLANNER_MODEL: 'gpt-6-sol',
    CAREER_OPS_PLANNER_REASONING_EFFORT: 'medium',
  });
}

// A stalled CLI can print a quota/auth failure and then keep reconnecting.
// Preserve that cause even when the outer deadline eventually kills it, so a
// timeout cannot accidentally authorize another model after usage exhaustion.
export function plannerFailure(stderr,{killed=false,code=null}={}) {
  const text=String(stderr);
  const status=/(?:unexpected\s+status|http(?:\s+status)?|status(?:\s+code)?)[\s:=]*(401|403|429)\b/i.exec(text)?.[1];
  const unavailable=status || /(?:usage|rate|quota)\s+limit\s+(?:reached|exceeded)|(?:hit|reached|exceeded)\s+(?:your\s+|the\s+)?(?:usage|rate|quota)\s+limit|quota\s+(?:exceeded|exhausted)|insufficient_quota|rate_limit_exceeded|invalid_api_key|authentication\s+(?:failed|expired|required)|not\s+(?:logged|signed)\s+in|please\s+(?:log|sign)\s+in/i.test(text);
  if(unavailable)return new Error(`Model usage/authentication unavailable${status?` (HTTP ${status})`:''}`);
  if(killed)return new Error(`Model timeout${/reconnect(?:ing)?|stream disconnected/i.test(text)?' (connection retries observed)':''}`);
  // Existing non-timeout CLI errors retain their established closed behavior.
  return new Error(/limit|quota|usage|auth|login|sign in/i.test(text)?'Model usage/authentication unavailable':`Model failed (${code})`);
}
export async function planJSON(prompt, schema = evaluationSchema, timeoutMs = 180000, env = process.env, {spawnProcess=spawn}={}) {
  // Validate project overrides before creating files or starting a model process.
  modelSelection('', env);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-planner-'));
  const schemaPath = path.join(dir, 'schema.json'), resultPath = path.join(dir, 'result.json');
  fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
  const configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  try {
    await new Promise((resolve, reject) => {
      const child = spawnProcess('codex', ['--ask-for-approval','never','exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only', '-c', 'features.shell_tool=false', ...modelSelection(config, env), '--output-schema', schemaPath, '--output-last-message', resultPath, '-'], { cwd: dir, stdio: ['pipe','pipe','pipe'] });
      let error = '', killed = false, unavailableCause = null;
      const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', () => {});
      child.stderr.on('data', d => {
        error = (error + d.toString()).slice(-1500);
        const observed=plannerFailure(error,{killed:true});
        if(observed.message.startsWith('Model usage/authentication unavailable'))unavailableCause=observed;
      });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => { clearTimeout(timer); code === 0 && !killed ? resolve() : reject(unavailableCause || plannerFailure(error,{killed,code})); });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
