---
name: Stall-Matrix Live Check
description: "Cadenced non-hermetic validation of ALL framework stall-coverage matrices (docs/frameworks/*-stall-coverage.md). A deterministic checker (scripts/stall-matrix-live-check.mjs) runs the checks hermetic CI cannot: closePath liveness against the commitments/actions ledger, guardKey/posture cross-check against the live /guards inventory, dead-ref flagging, the 45-day unreviewed-aging warning rung, and the §2.1 pending-mint flow (idempotent framework-issue filing + ONE aggregated commitment per mint pass). It raises ONE aggregated attention item on failures and NEVER edits source (the pending-mint → real-ref rewrite is an ordinary PR, not a runtime write). Offline-tolerant: server unreachable → a clear ledger-unreachable exit, no partial mints. Ships OFF by default (enabled:false) — ON for the development agent only, like other repo-gated jobs. perMachineIndependent — the gate machine's ledger is the resolution scope (machine-local posture). Spec: docs/specs/framework-stall-coverage-matrix.md §3.5 item 2b."
schedule: "0 5 * * 1"
priority: low
expectedDurationMinutes: 10
model: haiku
supervision: tier1
enabled: false
perMachineIndependent: true
tags:
  - cat:maintenance
  - role:worker
  - exec:prompt
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1
toolAllowlist: ["Bash"]
unrestrictedTools: false
mcpAccess: none
---
Run one stall-matrix live check. This job only INVOKES the deterministic checker and sanity-checks that it produced a well-formed result — the checker owns 100% of the matrix parsing, loopback HTTP, dedup-keyed issue filing, aggregation, and delivery (it performs the POST /framework-issues/observe + POST /commitments + POST /attention itself, in-process). You have Bash ONLY — no Edit/Write tool. Do NOT try to edit any source file; this job NEVER rewrites a matrix (a `pending-mint` → real-ref rewrite is an ordinary PR the operator/dev agent lands, never a runtime write to the checked-out tree).

1. **Checker-presence gate.** The checker is instar source — present only on a source-carrying agent (a maintainer/dev agent like Echo, and the fixture repos), NOT on a pure end-user agent. Run this SINGLE command (never chain it with `&&`/`||`/`;`):
   `test -f scripts/stall-matrix-live-check.mjs`
   If it exits NON-ZERO (the checker is absent), this agent carries no analyzable source tree — EXIT SILENTLY, there is nothing to do (the honest no-op path every non-source agent takes; the runtime gate's `matrix-unverifiable-no-source` verdict covers those installs). Do not message anyone. Only if it exits zero (present) do you proceed to step 2.

2. **Run the deterministic checker.** This is a FIXED literal invocation — never substitute flags:
   `node scripts/stall-matrix-live-check.mjs`
   The checker validates every matrix in `docs/frameworks/` at the non-hermetic depth: closePath refs must resolve to OPEN commitments/actions (a delivered/closed commitment is a DEAD ref — a closed anchor is no anchor), covered/covered-dark guardKeys are cross-checked against `GET /guards` (covered ⇒ live; covered-dark ⇒ dark/dry-run, not missing; `exempt:*` ⇒ vacuous-with-reason), seeded `unreviewed` rows past 45 days raise the warning rung (CI's 60-day red is CI's job, not this one), and every `pending-mint` row gets its idempotent framework-issue (dedupKey `stallclass::<class>::<framework>::unreviewed`) plus ONE aggregated open commitment per mint pass. Findings aggregate into ONE attention item; a clean pass surfaces nothing.

3. **Tier-1 supervision (your job) — sanity-check the run, do NOT re-surface anything yourself.** Confirm the checker exited cleanly (exit 0 = clean or findings-delivered; exit 2 = ledger-unreachable). A `ledger-unreachable` exit is NOT a matrix problem — note it once and exit; the next cadence retries (no partial mints happened, by design). The checker already delivered any findings in-process — you do NOT build or POST an attention item, and you do NOT relay progress to Telegram.

4. Exit. This job produces durable ledger entries + one aggregated review item for the operator, not a running commentary. A clean pass is not news — surface nothing.
