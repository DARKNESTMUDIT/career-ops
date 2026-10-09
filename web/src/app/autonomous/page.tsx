"use client";
import { useEffect, useState } from "react";
type Job = { id: string; url: string; track: string | null; state: string; payload: { company?: string; role?: string; fit?: number; reasons?: string[] } };
type Status = { paused: boolean; pauseReason?: string; lastRunError?: string; stage: string; active: { pid: number } | null; todayAttempts: number; jobs: Job[]; attempts: { id: string; outcome: string; receipt: string | null }[] };
export default function AutonomousPage() {
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(""), [track, setTrack] = useState("all"), [busy, setBusy] = useState(false);
  async function refresh() { try { const r = await fetch("/api/autonomous"); const data = await r.json(); if (!r.ok) throw new Error(data.error); setStatus(data); } catch (e) { setError(String(e)); } }
  useEffect(() => { void refresh(); const id = setInterval(() => void refresh(), 5000); return () => clearInterval(id); }, []);
  async function act(action: string, id?: string) { setBusy(true); setError(""); try { const r = await fetch("/api/autonomous", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id, track }) }); const data = await r.json(); if (!r.ok) throw new Error(data.error); await refresh(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  return <div className="mx-auto max-w-6xl space-y-6 p-6 md:p-10">
    <div><h1 className="text-3xl font-semibold">Internship runner</h1><p className="mt-2 text-muted">Remote through June 2027 · Summer July–August 2027</p></div>
    <p className="rounded-lg border border-border bg-surface p-4">Dry-run rollout. Applications are not sent while submission adapters and receipt checks await validation. Prepared resumes do not count as complete application dry runs.</p>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {(status?.lastRunError || status?.pauseReason) && <p role="status">{status.lastRunError || status.pauseReason}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <label>Track <select aria-label="Search track" className="rounded border p-2" value={track} onChange={e=>setTrack(e.target.value)}><option value="all">Both tracks</option><option value="remote">Remote</option><option value="summer">Summer</option></select></label>
      <button className="rounded border px-4 py-2" disabled={busy || !!status?.active || status?.paused} onClick={()=>void act("run")}>Run dry check</button>
      <button className="rounded border px-4 py-2" disabled={busy} onClick={()=>void act(status?.paused ? "resume" : "pause")}>{status?.paused ? "Resume" : "Pause"}</button>
      <span>{status?.active ? "Running" : status?.paused ? "Paused" : "Idle"} · {status?.todayAttempts ?? 0} attempts today · live limit 0 during dry run</span>
    </div>
    <h2 className="text-xl font-semibold">Applications and exceptions</h2>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-3">Role</th><th className="p-3">Track</th><th className="p-3">Fit</th><th className="p-3">State / reason</th><th className="p-3">Action</th></tr></thead><tbody>
      {status?.jobs.filter(j=>track === "all" || j.track === track || !j.track).map(j=><tr key={j.id} className="border-b border-border"><td className="p-3"><a className="underline" href={j.url} target="_blank" rel="noreferrer">{j.payload.company ? `${j.payload.company} — ${j.payload.role}` : j.url}</a></td><td className="p-3">{j.track ?? "Unclassified"}</td><td className="p-3">{j.payload.fit ?? "—"}</td><td className="p-3">{j.state}<p className="text-muted">{j.payload.reasons?.join("; ")}</p></td><td className="p-3">{["exception","rejected"].includes(j.state) && <button disabled={busy} className="underline" onClick={()=>void act("retry",j.id)}>Re-evaluate</button>}</td></tr>)}
    </tbody></table></div>
    {!status?.jobs.length && <p className="text-muted">No queued applications yet. Run a dry check to import the existing pipeline.</p>}
    <h2 className="text-xl font-semibold">Receipts</h2>
    {status?.attempts.length ? status.attempts.map(a=><p key={a.id}>{a.outcome}: {a.receipt ?? "Awaiting verified outcome — no automatic retry"}</p>) : <p className="text-muted">No submissions attempted.</p>}
  </div>;
}
