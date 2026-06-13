# Side-Effects Review — Build-Session Yield Safety (ACT-839)

**Version / slug:** `build-session-yield-safety`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `spec-converge (7 rounds, zero material findings) + Standards-Conformance Gate`

## Summary of the change

Implements the converged + operator-approved `BUILD-SESSION-YIELD-SAFETY-SPEC`: a reaped session whose worktree holds uncommitted work becomes resume-eligible (R1 — a new `uncommitted-worktree-work` STRONG `WorkEvidence` value, collected pre-kill by the killer via a shared bounded `worktreeDirtyCheck` helper), and a revived session gets a durably-tracked obligation to commit/preserve that work (R2 — an evidence-specific continuation-prompt directive, a revival-scoped CommitmentTracker commitment, drain-tick delivery, and a non-destructive preservation patch). Ships dev-gated (ON dev / OFF fleet) per the Maturation Path standard. Files: `src/core/worktreeDirtyCheck.ts` (new), `src/core/WorkEvidence.ts`, `src/config/ConfigDefaults.ts`, `src/core/devGatedFeatures.ts`, `src/monitoring/ResumeQueue.ts` + `ResumeQueueDrainer.ts`, `src/core/PostUpdateMigrator.ts`, the killer collection site, plus tests + agent-awareness docs.

## Decision-point inventory

- `WorkEvidence eligibility (R2.2)` — pass-through — the new STRONG value feeds the EXISTING `evidenceEligible` classifier; no new gate logic, and it never overrides the `origin==='operator'` veto.
- `worktreeDirtyCheck` — add — a new read-only "is this worktree really dirty?" decision (porcelain non-empty AND non-residue), fail-open.
- `ResumeQueue revival → commitment` — add — opens one beacon-eligible commitment per (session, worktree); dedupes on re-revival.
- `dev-gate (developmentAgent)` — pass-through — registers in the existing `DEV_GATED_FEATURES` resolution; no new gate mechanism.

## 1. Over-block

No block/allow surface — over-block not applicable. R1 is read-only signal collection; R2 is signal + a tracked obligation, explicitly NOT a blocking gate (the first-yield BLOCK was rejected at spec review on Signal-vs-Authority). The dirty-check is fail-open: a git error/timeout/non-git path yields NO signal, so it can never over-block a revival.

## 2. Under-block

The dirty-check can MISS real work (under-signal) when: git times out (>5s), the worktree path won't resolve, or all dirty entries match the residue denylist. All are deliberate fail-open choices — the cost is "no revival this time," and OrphanedWorkSentinel (#1113) still surfaces a missed dirty worktree post-hoc. A consistently-timing-out worktree is surfaced loudly (≥3 consecutive → HIGH attention), so silent permanent under-signal is caught.

## 3. Level of abstraction

The dirty-check lives in `src/core/` as a pure injectable helper reused by both the killer (monitoring) and the drainer (monitoring) — one implementation, not two. The evidence value lives in the existing `WorkEvidence` vocabulary clamped at the single kill chokepoint. No logic is duplicated; no cross-layer reach.

## 4. Signal vs. Authority

Fully compliant — and the central design point. R2 is a SIGNAL (directive) + a durable beacon, never a blocking authority over a session's yield. The only mutations are loss-reducing: a non-destructive preservation patch (never touches index/ref/history; secret-scrubbed; size-capped) and the session's own commits. The system never auto-commits on the agent's behalf to published history. The operator origin-veto remains final.

## 5. Interactions with adjacent systems

- **ResumeQueue / Drainer:** extends the existing midWork revival path; adds one evidence value + one commitment registration + a drain-tick delivery check. No parallel queue.
- **PromiseBeacon / CommitmentTracker:** reuses them for the obligation; deduped so no beacon flood.
- **OrphanedWorkSentinel (#1113):** complementary (post-hoc detector); R2 delivery prefers its sweep as an optimization but does not hard-depend on it (drain-tick is primary).
- **Kill chokepoint:** the dirty-check runs PRE-kill in the killer's loop, never synchronously on `terminateSession` — the event loop is never blocked per-kill.

## 6. Rollback cost

Low and clean. Ships dev-gated: disabling = flip the `developmentAgent` resolution / set `monitoring.resumeQueue.yieldSafety.enabled:false` → the feature is fully inert (the evidence value is harmless if never produced; the drainer delivery-check no-ops). No schema migration to reverse beyond a config key. The preservation patches are additive files under `state/`. Reverting the PR removes the code with no durable-state cleanup required.

## Evidence

Not a bug fix — a new dark, dev-gated feature. Verified by the spec's 3-tier + wiring-integrity test plan (unit: dirty-check both sides, anti-gaming, bounds, operator-veto, dedup; integration: route + commitment; e2e: feature-alive + revive-of-revive preservation). The shared `worktreeDirtyCheck` foundation ships with 19 unit tests both sides of every boundary.

## Implementation log

- 2026-06-13: shared `worktreeDirtyCheck` helper (foundation) landed + 19 unit tests.
- 2026-06-13: R1 — `uncommitted-worktree-work` evidence value, `monitoring.yieldSafety` config (enabled OMITTED, dev-gated), `DEV_GATED_FEATURES` registration; dark-gate golden line-map recomputed.
- 2026-06-13: R1 killer-wiring — SessionReaper collects the pre-kill dirty-check (session.cwd) and carries uncommitted-worktree-work; server.ts injects the bounded dirtyCheck only when the dev-gate is live; 5 reaper tests both sides + fail-open + no-cwd + feature-dark.
- 2026-06-13: R2 directive — ResumeQueueDrainer.continuationPrompt prepends the verbatim commit-first directive when uncommitted-worktree-work present (+ build-active 2nd sentence); 4 tests.
- 2026-06-13: R2 commitment-beacon — drainer fires onWorktreeRevival on revival of an uncommitted-worktree entry; server.ts registers a deduped beacon-enabled CommitmentTracker obligation (externalKey yield-safety:stableKey). DRY reconciliation: the die-again detect+preserve is the dev-live #1113 sentinel, NOT a duplicate in the drainer (spec updated; the "preserve-before-destroy" property was found unachievable). 3 drainer hook tests.
