# Side-Effects Review — doorway scan: a run really scans

**Version / slug:** `doorway-scan-real-run`
**Date:** `2026-10-30`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see bottom)`

## Summary of the change

Tier 1. Finishes `main()` in `scripts/doorway-scan.mjs`, makes the job script
require a fresh state file, and adds a must-fail canary. Files: the prober, the
job script, `src/scheduler/ScriptCanaryRunner.ts`, tests, spec, overview. Spec
review: one round, on the code (the parent spec is already converged and
approved).

**Decision-point inventory:** the job's ok/failed verdict is tightened. The
prober's surface-or-stay-silent decision was specified and is now reached for
the first time. No new blocking authority.

## 1. Over-block

The job reports `failed` when the state file is stale or missing, which is the
intent. A clock step backwards between start and stamp could fail one run; the
next cadence retries. No other legitimate input is rejected.

## 2. Under-block

A free probe proves a door answers, not that it can generate. A logged-out CLI
still passes `--version`. All five doors are `cli-version`, so no new model is
ever observed. That is stated in the spec, and it means CMT-978's wider aim
(tracking the latest model) is not met by this scan alone.

## 3. Level-of-abstraction fit

Right layer: the prober owns probing and delivery per the parent spec. The
freshness check sits in the job script because that is what produces the
verdict the scheduler records, and it does not trust the prober's exit code.

## 4. Signal vs authority compliance

Compliant. The scan only reads and reports; the attention item is a signal. See
`docs/signal-vs-authority.md`. It gates nothing and never edits canonical source.

## 5. Interactions

- Script runner: a failed run now counts toward crash-loop handling, where it
  used to read as success. That is the honest result.
- Session-rollback runner (Echo today): the session runs the same prober, which
  now exits 1 on a fatal error.
- Canary: the extra variant adds one stub run a day, and the 2 standard variants
  are unchanged. `emptyStateDir` sets `INSTAR_STATE_DIR` for that child only.
- Tone gate: a 422 on `/attention` is a held notice; the baseline does not move
  and the notice returns on the next scan, as the parent spec requires.

## 6. External surfaces

`GET /doorways` moves from `never-run` to `scanned` where the job runs. One new
stable attention row per machine can appear. Nothing goes to other agents. The
probes run local `which` and `--version` only and make no network call.

## 7. Multi-machine posture

Machine-local BY DESIGN: each machine scans its own disk (`perMachineIndependent`,
parent spec §2.8). The attention id carries the machine id, so two machines'
findings never coalesce. No state is replicated and no URL crosses machines
except the existing tunnel-gated view link.

## 8. Rollback cost

A plain revert. A leftover state file is harmless. `enabled: false` on the job
manifest stops it at once. No migration and no shared state.

## Second-pass review

Independent subagent. First pass: **Concern raised**, two verified defects: a
door that recovered never returned to `true` in the baseline, so its next outage
stayed silent; and a failed breaker escalation was lost, because the breaker
fires only at the exact threshold. Both fixed with tests. Its checks of the
canary env path, the metered refusal and secret handling were clean. Second
pass: **Concern raised**: sharing `lastDeliveryFailedAt` could repost a delivered
escalation while a change notice stayed held. Fixed with a dedicated
`escalationPending` field and a test. Third pass: **Concur with the review**.
