# Side-Effects Review — a machine whose lease role changed restarts once

**Version / slug:** `lease-takeover-role-restart`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** codex-cli gpt-6-astra, 2 rounds; first round's findings fixed; last round's verdict still serious, its point stated as an accepted limit, see the convergence report

## Summary of the change

Behind the dark `soloCaptainHold` switch, with no named preferred machine and a peer: a machine that loses the lease pauses jobs at once, and a machine whose role differs from its boot role requests one planned restart so boot builds what the role needs. `src/core/roleFollowRestart.ts`, `src/commands/server.ts`.

## Decision-point inventory

- Restart on role change — add — config facts and a recorded time.
- Pause jobs on demotion — add — under the same conditions.

---

## 1. Over-block

Under the conditions, a machine that loses the lease stops starting jobs, which is the point. Jobs already running finish.

## 2. Under-block

Polling is not covered. With the stamp unwritable and a flapping lease, restarts are unbounded; stated in the spec.

## 3. Level-of-abstraction fit

Reuses boot, the one tested place that builds a role, instead of a second start path across 98 references.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. Reads config and lease role. No judgment of content.

## 5. Interactions

Uses the update restart file and its consumers. The restart holds that protect a running verify apply. `pause` and `resume` are the scheduler's existing calls.

## 6. External surfaces

None with the switch off. With it on, a short restart after a role change.

## 7. Multi-machine posture

Machine-local by design: each machine's role and stamp are its own. The lease fence is unchanged.

## 8. Rollback cost

`soloCaptainHold.enabled: false`, read live. The stamp file is inert.
