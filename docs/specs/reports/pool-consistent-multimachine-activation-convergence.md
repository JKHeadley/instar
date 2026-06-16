# Convergence Report — Pool-Consistent Activation for Multi-Machine Dev-Gated Features

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (the agent's codex CLI) ran on every round. (Gemini was
not re-run this cycle; codex ran cleanly each round, so the spec received genuine
cross-model review throughout.)

## ELI10 Overview

The "prove it live" standard caught a real bug in my cross-machine transfer fix: it only
turned on for my dev machine, so on the *other* machine (the Mac Mini, not flagged as a
dev machine) it stayed off — and a conversation that "moved" there died on arrival. This
spec fixes that: a two-machine feature can't depend on a switch each machine reads on its
own. The transfer fix now turns on wherever its real prerequisite (the cross-machine
record-sync) is on — which is on consistently on both machines — so it comes up on both
together. Plus two backstops: a guard that refuses a move to a machine that isn't ready
(rather than half-moving), and a watchdog that flags a half-on feature loudly.

## Original vs Converged

The original spec proposed a loose `dev OR dependency` gate and a config-comparing
detector. Review (codex, SERIOUS at round 1) reshaped it substantially:
- The activation predicate was pinned to the EXACT signal (`coherenceJournal.replication.
  enabled === true`, the one already gating the placement-replication applier) with a stated
  invariant — not a flag-conflation.
- It was reframed as **pool-scoped production promotion** (the durable store activates on
  every replication-on pool machine), with explicit blast-radius — not a local dev toggle.
- The detector was upgraded to compare **effective runtime** materialization (the incident
  was config-vs-behavior mismatch) + independent self-reported health, treating an
  unreachable peer as "unknown," not silently "dark."
- A **capability-refuse** safety net was added (fail-closed: refuse a transfer to a peer not
  freshly-active or behind the placement epoch → honest `seatMoved:false`), closing the
  rolling-deploy / drift window.
- The lint was made a testable invariant (a simulated 2-machine config must resolve the same
  activation), not a paperwork declaration.

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes |
|-----------|-----------|-------------------|--------------|
| 1 | conformance (clean), internal panel, codex (SERIOUS) | ~7 | predicate flag-conflation → pinned signal + invariant; pool-scoped model; detector + capability-refuse adopted |
| 2 | codex (MINOR) | 3 | detector health-record; backfill (already handled by applier); detector self-failure |
| 3 | codex (MINOR) | 2 | capability-refuse freshness contract; detector ≠ self-dependent |
| 4 | codex (MINOR) | 2 | local-predicate framing; epoch-freshness in capability-refuse |
| — | (converged) | 0 material-new (only hardening refinements, all folded) | — |

## Full Findings Catalog (by theme)

- **Activation predicate (HIGH, r1):** flag-conflation → gate on `_replicationEnabled`
  (server.ts:16588) with the invariant "a machine consuming replicated placements runs the
  ownership applier." RESOLVED + built.
- **Pool-scoped promotion (MED, r1/codex2):** explicit blast-radius disclosure. RESOLVED.
- **Detector (MED, r1-r3):** compare effective runtime, not config; independent self-health;
  unknown≠dark. RESOLVED.
- **Capability-refuse (MED, r2-r4):** heartbeat fields + freshness TTL + version + epoch
  check; fail-closed. RESOLVED.
- **Boot-race (MED, r1):** the applier already backfills (queries existing placements per
  tick). RESOLVED (no new code; add a backfill test).
- **Lint (MED, r2):** testable invariant, not paperwork. RESOLVED.

## Convergence verdict

Converged. The external verdict descended SERIOUS → MINOR → MINOR → MINOR; the final
findings were hardening refinements, all folded; zero open questions. The core fix (the
activation predicate) is built + unit-tested. Build order: PR1 (predicate, the bar) → PR2
(capability-refuse) → PR3 (detector + lint). Ready for approval.
