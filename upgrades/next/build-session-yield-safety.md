# Upgrade Guide — Build-Session Yield Safety

<!-- bump: minor -->

## What Changed

A new dev-gated monitoring capability — **Build-Session Yield Safety** (ACT-839) — closes the "a background build died standing-by-for-tests with its work uncommitted" gap. R1: a session reaped while its worktree holds real uncommitted work is now resume-eligible on that alone — the killer (`SessionReaper`) runs a bounded, cached, fail-open `worktreeDirtyCheck` on the session's worktree PRE-kill (never a synchronous git call on the terminate chokepoint) and tags a new `uncommitted-worktree-work` STRONG `WorkEvidence` value. R2 (Close-the-Loop, signal not block): the revived session's continuation prompt leads with a verbatim commit-first directive, and `ResumeQueueDrainer` fires `onWorktreeRevival`, which registers a deduped, beacon-enabled `CommitmentTracker` obligation so a *stalled* revived session is re-surfaced by PromiseBeacon. The *die-again* case reuses the already-shipped, dev-live `OrphanedWorkSentinel` (#1113) for detect+preserve+surface — no duplicate scanner. An explicit operator/user/emergency kill is never auto-revived on a dirty worktree alone (the origin veto is final). Ships ENABLED on developer agents, dark on the fleet, per the new **Maturation Path** constitutional standard.

audience: agent-only
maturity: experimental

## What to Tell Your User

Nothing to announce proactively — it's an experimental safety net that runs on developer agents. If anyone asks: a background build that gets shut down before it saves its work now gets brought back and reminded to commit, instead of the work quietly vanishing.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Revive a session reaped with a dirty worktree | Automatic (dev-enabled, dark on fleet) |
| Durable "commit your worktree" obligation | `GET /commitments` (beacon re-surfaces a stalled revive) |
| Tune the dirty-check / residue denylist | `monitoring.yieldSafety.*` config |

## Evidence

Not a bug fix — a new dark, dev-gated feature; "not reproducible in dev" in the bug-fix sense. Verified by the 3-tier test plan: 19 unit tests for the shared `worktreeDirtyCheck` (both sides of every boundary + fail-open + cache), 5 reaper tests (dirty → evidence, clean → empty, feature-dark → empty, throw → fail-open, no-cwd → not-consulted), 7 drainer tests (the directive + the revival-obligation hook), and an e2e wired-pipeline test (a reaped dirty-worktree session is revived → the directive appears → a real beacon-enabled commitment is registered + deduped). tsc clean; full lint + dark-gate golden line-map + docs-coverage green.

