---
name: Doorway Scan
description: "Cadenced live re-probe of every doorway + top-model map refresh + drift diff. A deterministic prober (scripts/doorway-scan.mjs) probes CLIs (which/--version/model-list) and free model-list APIs, updates the per-agent live scan-state (.instar/state/doorway-scan.json), diffs against the previous scan, and raises ONE operator attention item with ONLY the changes (jargon-safe body + a private-view link to the raw diff). It NEVER auto-edits canonical source. Free probes by default; metered liveness / web-verify are opt-in, budget-capped, human-manual-only, and refuse on an unknown price. Ships OFF by default (enabled:false). perMachineIndependent — each machine scans its own disk. Spec: docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md §2."
schedule: "0 4 * * 1"
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
Run one doorway scan. This job only INVOKES the deterministic prober and sanity-checks that it produced a well-formed result — the prober owns 100% of the network I/O, secret handling, timeouts, sanitization, and delivery (it performs the POST /view + POST /attention itself, in-process). You have Bash ONLY — no Edit/Write tool — and a PreToolUse command-allowlist guard restricts this session's Bash to the sanctioned prober invocation + the /health gate + read-only plumbing. Do NOT try to edit any source file; this job NEVER auto-applies a change to the canonical registry (a stale map surfaces as a maintainer diff for the operator, never an edit).

1. **Prober-presence gate.** The prober is instar source — present only on a source-carrying agent (a maintainer/dev agent like Echo, and the fixture repos), NOT on a pure end-user agent. Run this SINGLE command (the command-allowlist guard permits only simple invocations — never chain it with `&&`/`||`/`;`):
   `test -f scripts/doorway-scan.mjs`
   If it exits NON-ZERO (the prober is absent), this agent carries no prober — EXIT SILENTLY, there is nothing to do (the honest no-op path every non-source agent takes). Do not message anyone. Only if it exits zero (present) do you proceed to step 2.

2. **Run the deterministic prober at the free scope (the ONLY scope the scheduled cadence runs).** This is a FIXED literal invocation — never substitute the scope, never append a metered scope; a metered scope spends money and is human-manual-only:
   `node scripts/doorway-scan.mjs --scope free-probes`
   The prober probes each configured door, updates the machine-local scan-state (`.instar/state/doorway-scan.json`), diffs against the last-surfaced baseline, and — only if there is a real, debounced, live-corroborated change — raises ONE attention item itself, in-process, with a machine-qualified `sourceContext` (`doorway-scan:<machineId>`) so two machines' findings never coalesce into one row. Free model-LIST probes spend ZERO tokens; the scheduled cadence spends no metered budget.

3. **Tier-1 supervision (your job) — sanity-check the run, do NOT re-surface anything yourself.** Confirm the prober exited cleanly and wrote/refreshed the scan-state. A crashed/partial run is NOT a signal — note it once and exit; the next cadence retries (the prober is fail-safe per-probe, and a completely-failed scan is handled by the prober's own breaker, which retries on a widening backoff and escalates ONE deduped item only after 3 consecutive complete failures). The prober already delivered any diff in-process — you do NOT build or POST an attention item, and you do NOT relay progress to Telegram.

4. Exit. This job produces a review artifact for the operator (a maintainer diff), not a running commentary. A clean scan is not news — surface nothing. The canonical map changes only when the operator folds a surfaced diff via instar-dev and re-runs the freshness lint; this job never touches source.
