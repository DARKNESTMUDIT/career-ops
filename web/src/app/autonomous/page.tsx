"use client";
import { useEffect, useState } from "react";
type Job = { id: string; url: string; track: string | null; state: string; payload: { company?: string; role?: string; fit?: number; reasons?: string[] } };
type Status = { paused: boolean; pauseReason?: string; lastRunError?: string; stage: string; gmail?: { connected: boolean; email: string }; rollout?: { limit?: number | null; completeDryRuns: number; tracks: string[]; verifiedApplications: number; consecutiveCleanDays: number; reasons: string[]; adapterValidation: Record<string, boolean> }; active: { pid: number } | null; todayAttempts: number; jobs: Job[]; attempts: { id: string; outcome: string; receipt: string | null }[] };
export default function AutonomousPage() {
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(""), [track, setTrack] = useState("all"), [busy, setBusy] = useState(false);
  async function refresh() { try { const r = await fetch("/api/autonomous"); const data = await r.json(); if (!r.ok) throw new Error(data.error); setStatus(data); } catch (e) { setError(String(e)); } }
  useEffect(() => { void refresh(); const id = setInterval(() => void refresh(), 5000); return () => clearInterval(id); }, []);
  async function act(action: string, id?: string) { setBusy(true); setError(""); try { const r = await fetch("/api/autonomous", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id, track }) }); const data = await r.json(); if (!r.ok) throw new Error(data.error); await refresh(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
  return <div className="mx-auto max-w-6xl space-y-6 p-6 md:p-10">
    <div><h1 className="text-3xl font-semibold">Internship runner</h1><p className="mt-2 text-muted">Applications matching your approved roles and availability.</p></div>
    <p className="rounded-lg border border-border bg-surface p-4">Each application is checked before submission. Confirmed receipts and tracker entries appear below.</p>
    <div className="rounded-lg border border-border p-4 space-y-2" aria-label="Connection and rollout progress">
      <p>Gmail: {status?.gmail?.connected ? `Connected as ${status.gmail.email}` : "Not connected"}. Connection status reflects the last successful verification.</p>
      <p>Current complete application bundles: {status?.rollout?.completeDryRuns ?? 0} · Tracks: {status?.rollout?.tracks.join(", ") || "None"}</p>
      <p>Verified applications: {status?.rollout?.verifiedApplications ?? 0} · Consecutive clean operating days: {status?.rollout?.consecutiveCleanDays ?? 0}</p>
      {status?.rollout?.reasons.map(reason=><p key={reason} className="text-muted">{reason}</p>)}
      {status?.rollout?.adapterValidation && <p>Adapter validation: {Object.entries(status.rollout.adapterValidation).map(([name,valid])=>`${name}: ${valid ? "validated" : "pending"}`).join(" · ")}</p>}
    </div>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {(status?.lastRunError || status?.pauseReason) && <p role="status">{status.lastRunError || status.pauseReason}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <label>Track <select aria-label="Search track" className="rounded border p-2" value={track} onChange={e=>setTrack(e.target.value)}><option value="all">Both tracks</option><option value="remote">Remote</option><option value="summer">Summer</option></select></label>
      <button className="rounded border px-4 py-2" disabled={busy || !!status?.active || status?.paused} onClick={()=>void act("run")}>Prepare applications</button>
      <button className="rounded border px-4 py-2" disabled={busy || !!status?.active || status?.paused} onClick={()=>void act("live")}>Send verified applications</button>
      <button className="rounded border px-4 py-2" disabled={busy} onClick={()=>void act(status?.paused ? "resume" : "pause")}>{status?.paused ? "Resume" : "Pause"}</button>
      <span>{status?.active ? "Running" : status?.paused ? "Paused" : "Idle"} · {status?.todayAttempts ?? 0} attempts today · {status?.rollout?.limit === null ? "No daily application cap" : status?.rollout?.limit === undefined ? "Checking application capacity" : `${status.rollout.limit} applications per day`}</span>
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
