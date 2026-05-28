# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Second automatic feed for the Failure-Learning Loop: the **revert source** (spec `docs/specs/FAILURE-LEARNING-INGESTION-SOURCES-SPEC.md` §3.2). This completes the approved "CI + reverts" first slice — the CI source shipped already; this adds detection of *undone changes*. Off by default (`monitoring.failureLearning.sources.revert`); no change when off.

When a change is reverted, that's strong evidence the original was bad enough to pull. The revert source scans recent commits for `Revert "…"` and records it — but it is careful, because commit messages are attacker-authorable: it will only mark an existing recorded failure as resolved if the revert genuinely reverses that commit (the reverted commit is real and reachable AND the revert's diff actually touches the same files), and the match is on both the feature and the exact commit — so a hand-written "this reverts X" can't quietly close someone else's record. A revert that fails those checks can at most file a low-confidence note, never close anything. A revert-of-a-revert (a re-land) is ignored — it isn't a failure.

## What to Tell Your User

- The failure-watcher now also notices when a change gets undone — and treats that as "this was probably a real problem." It's careful not to be fooled by a faked undo message into marking the wrong thing as solved.
- Like the CI watcher, it's off until switched on and only quietly records — no alerts.
- This finishes the first set of automatic feeds (failed builds + undone changes). The next sets (a shipped feature breaking, and runtime fallbacks) are separate, later steps.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Revert ingestion source | Set `monitoring.failureLearning.sources.revert: true` |

## Evidence

- 13 tests green: RevertDetector (9 — parse, trusted close, failed-cross-check-no-close, no-original forensic record, revert² skip, unreachable→low-confidence, loop self-exclusion, idempotent across ticks, fail-open), wiring-integrity (4 — CI poller + revert detector each constructed iff its own flag is set).
- `tsc --noEmit` clean; existing failure-learning + slice-1a tests unaffected.
- Side-effects review: `upgrades/side-effects/failure-learning-revert-source.md`.
