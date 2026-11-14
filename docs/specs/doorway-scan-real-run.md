---
title: "Doorway scan: a run really scans, and only a fresh state file counts as success"
slug: "doorway-scan-real-run"
author: "echo"
status: "tier-1"
parent-spec: "docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md"
eli16-overview: "docs/specs/doorway-scan-real-run.eli16.md"
---

# Doorway scan: a run really scans (CMT-978)

## Problem

`scripts/doorway-scan.mjs` holds every piece of the approved doorway scan as a
tested function, but its `main()` was never finished. It printed
"increment 2 ships DARK" and exited 0. The job, its canaries and the job
history all reported success, while no scan-state file ever existed and
`GET /doorways` said `never-run`.

## Change

1. `main()` runs the scan the parent spec describes: load scan-state through
   the validating funnel, probe every door one at a time under the per-probe
   and global bounds, apply the debounce, diff against the last-surfaced
   baseline, write scan-state atomically, deliver a real change through
   `/view` + `/attention`, and advance the baseline only on a confirmed 2xx.
2. The prober reads the written file back. A run that cannot persist its state
   exits 1 with `doorway-scan: fatal:`. It used to exit 0 on any fatal error.
3. The job script reports `ok` only when the state file exists and this run
   stamped `lastScanAt`. Otherwise it fails with `scan-state-missing`,
   `scan-state-unreadable` or `scan-state-stale`.
4. A must-fail canary, `scan-state-missing`, runs a stub prober that prints a
   healthy scope line and writes nothing, against an empty state directory.
   The canary passes only for that exact reason code, so it cannot pass by
   failing for some other reason.

Two bugs in the existing pieces had to be fixed for the scan to be correct:

- `loadScanState` turned a stored `reachable: null` into `false`. Unknown must
  stay unknown (§1.3).
- A door that was never installed would have raised "went unreachable", and a
  held notice would never have come back. `wentUnreachable` is now decided
  against the last-surfaced baseline: it needs `reachable: true` there. On a
  quiet scan the baseline learns the two changes that raise no notice, unknown
  to known and a recovery, so the next outage can surface.

A breaker escalation that fails to deliver is retried on each later scan while
the failure lasts, because the breaker itself fires only at the threshold.

New scan-state fields: `escalationPending`, and `maintainerViewId`, needed because `PUT /view/:id` only
updates an existing view, so the stable view id has to be remembered.

## What this does not do

- The free probes prove a door answers. All five doors use `cli-version`, which
  lists no models, so this scan cannot notice a new model on its own.
- `+liveness` and `+web-verify` stay unbuilt, as they were. A metered scope is
  now refused for every caller, not only for scheduled runs, so nothing spends.
- The vault-key notice (§2.5) and the `high` priority for a critical door
  (§2.6) stay unbuilt, as they were.
- The widening skip between attempts after a complete failure (§2.3) is not
  applied. Zero doors answering costs only local `which` calls, the cadence is
  weekly, and skipping a run would leave no fresh state to judge it by.

Each of these is filed in the feedback queue.

## Rollback

Revert the PR. The job goes back to the stub, and an existing state file only
makes `GET /doorways` show a past scan. Stop the job with `enabled: false` on
its manifest. Nothing here migrates or touches shared state.
