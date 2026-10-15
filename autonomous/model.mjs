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
export async function planJSON(prompt, schema = evaluationSchema, timeoutMs = 180000, env = process.env) {
  // Validate project overrides before creating files or starting a model process.
  modelSelection('', env);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-planner-'));
  const schemaPath = path.join(dir, 'schema.json'), resultPath = path.join(dir, 'result.json');
  fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
  const configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('codex', ['--ask-for-approval','never','exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only', '-c', 'features.shell_tool=false', ...modelSelection(config, env), '--output-schema', schemaPath, '--output-last-message', resultPath, '-'], { cwd: dir, stdio: ['pipe','pipe','pipe'] });
      let error = '', killed = false;
      const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', () => {});
      child.stderr.on('data', d => { error = (error + d.toString()).slice(-1500); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => { clearTimeout(timer); code === 0 && !killed ? resolve() : reject(new Error(killed ? 'Model timeout' : /limit|quota|usage|auth|login|sign in/i.test(error) ? 'Model usage/authentication unavailable' : `Model failed (${code})`)); });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
