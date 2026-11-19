# Local Verify records how long each unit test file takes

<!-- bump: patch -->

## What Changed

Local Verify already kept a per-file duration history (`.worktrees/.verify/file-durations.json`) for the integration and e2e lanes, which it uses to balance their shards. It now records unit-lane files as well. Shard planning reads only a lane's own files, so unit entries never change an integration or e2e plan. Each run also logs one `unit-wall-factor` row: the unit lane's wall time divided by its file time spread across the workers (1.22 measured on the Studio on 2026-11-18). Later sharding and borrowed-machine slice planning need both numbers (spec `docs/specs/local-verify-borrowed-unit-slices.md`, part A).

The history file grows from about 94 KB to about 315 KB, well under its 2 MB and 20,000-entry caps. The change touches the verifier, so the verifier version changes once with this release; run machines and peers must be on the same release to share work, as with any verifier change.

## What to Tell Your User

- **Test timing record**: "My test line now keeps a record of how long every quick test takes, not just the slow ones. Nothing about how tests run changes; the record is what any later speed-up gets planned from."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Unit-test durations in the duration history | Read `.worktrees/.verify/file-durations.json` (unit files now included) |
| Unit lane wall factor per run | `unit-wall-factor` rows in the run logs under `.instar/state/local-verify/runs/` |

## Evidence

`tests/unit/localVerify/orchestrator.test.ts`: unit files appear in the history after a run; the `unit-wall-factor` row is logged with the worker count; a history carrying unit entries yields the same integration and e2e shard lists as one without them. 108/108 with `shardPlan.test.ts`. Typecheck clean.
