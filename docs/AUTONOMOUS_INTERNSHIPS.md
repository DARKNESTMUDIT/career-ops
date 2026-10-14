# Autonomous internship runner

This local runner prepares source-backed application bundles and submits only
through certified channels after the rollout requirements pass. User data stays
in the configured data root. OAuth credentials stay in macOS Keychain; do not
commit client JSON, primary profiles, bundles, ledgers, or personal handoffs.

## Operation

Run discovery and preparation first:

```sh
CAREER_OPS_PLANNER_MODEL=gpt-6.1-sol CAREER_OPS_PLANNER_REASONING_EFFORT=medium node autonomous-runner.mjs run --dry-run --discover
```

Then invoke the guarded submission phase:

```sh
node autonomous-runner.mjs run --live
```

`--job UUID` limits either phase to the selected job. Live mode never evaluates
new candidates or bypasses certification, eligibility, recipient evidence,
bundle fingerprints, rollout, quotas, duplicate checks, or the runner lock.
Preparation is required even when live operation is authorized.

Five current complete bundles across both configured tracks unlock the pilot
stage. Three receipt-and-tracker-verified pilots precede five applications/day.
Ten/day requires ten verified applications and seven consecutive completed clean
operating days. These are ceilings. Synthetic test fixtures earn no production
credit. Unsupported forms, missing answers and eligibility remain exceptions.

## Recovery

After an uncertain email, never retry sending. Reconcile its durable Message-ID:

```sh
node autonomous-runner.mjs gmail-reconcile UUID
node autonomous-runner.mjs sync
node autonomous-runner.mjs recover
```

Reconciliation requires one exact sent-mail provider receipt, matching sender,
recipient, Message-ID and provider timestamp. Synchronization uses the canonical
TSV merger and locked status writer. `recover` independently verifies every
attempt and canonical tracker marker, identity, status and receipt under both
writer locks before clearing a recognized integrity pause. It sends nothing and
restores no clean-day credit. Ordinary `resume` cannot clear integrity failures.
Ambiguous or absent evidence stays paused. Form reconciliation is unsupported;
form adapters remain closed until provider-specific acceptance and recovery are
certified.

## Local dashboard and scheduling

```sh
cd web
npm run build
npm run start -- --port 3041
```

The production dashboard binds only to `127.0.0.1`. Keep the Mac available and
Keychain unlocked for scheduled runs. One daily scan/preparation pass followed
by a gated submission pass is sufficient initially. Keep model use limited to
structured evaluation; scanning, filling, sending and reconciliation use code.
Gmail OAuth apps in Testing have limited refresh-token lifetime; successful
current refresh does not establish indefinite unattended authorization.
