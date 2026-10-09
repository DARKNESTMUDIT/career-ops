import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolveCodeRoot, resolveRootScript } from "@/lib/core/code-root.mjs";
import { careerOpsRoot } from "@/lib/career-ops";
import { checkRequest } from "@/lib/origin-guard.mjs";
const exec = promisify(execFile);
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function invocation() {
  const cwd = resolveCodeRoot(process.cwd());
  return { cwd, script: resolveRootScript(cwd, "autonomous-runner"), env: { ...process.env, CAREER_OPS_ROOT: careerOpsRoot() } };
}
function guard(req: Request) {
  const r = checkRequest({ host: req.headers.get("host"), origin: req.headers.get("origin"), secFetchSite: req.headers.get("sec-fetch-site"), allowedHosts: new Set<string>() });
  return r.ok ? null : Response.json({ error: r.reason }, { status: r.status });
}
export async function GET(req: Request) {
  const blocked = guard(req); if (blocked) return blocked;
  try {
    const { cwd, script, env } = invocation();
    const { stdout } = await exec(process.execPath, [script, "status"], { cwd, env, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    return Response.json(JSON.parse(stdout));
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Status unavailable" }, { status: 500 }); }
}
export async function POST(req: Request) {
  const blocked = guard(req); if (blocked) return blocked;
  try {
    const { action, id, track = "all" } = await req.json();
    if (!["run", "pause", "resume", "retry"].includes(action) || !["all", "remote", "summer"].includes(track)) return Response.json({ error: "Invalid operation" }, { status: 400 });
    if (action === "retry" && (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))) return Response.json({ error: "Invalid application ID" }, { status: 400 });
    const { cwd, script, env } = invocation();
    if (action === "run") {
      const child = spawn(process.execPath, [script, "run", "--dry-run", "--track", track], { cwd, env, detached: true, stdio: "ignore" });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      return Response.json({ accepted: true }, { status: 202 });
    }
    const { stdout } = await exec(process.execPath, [script, action, ...(action === "retry" ? [id] : [])], { cwd, env, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    return Response.json(JSON.parse(stdout));
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Operation failed" }, { status: 400 }); }
}
