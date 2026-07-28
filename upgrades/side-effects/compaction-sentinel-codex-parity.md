# Side-Effects Review — CompactionSentinel codex parity

**Slug:** `compaction-sentinel-codex-parity`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** independent review — **CONCUR (ship active), no must-fix.**

## Summary
CompactionSentinel.readJsonlBaseline gains a codex branch (newest rollout via
findNewestRolloutSync) so codex compaction-recovery is verified instead of falsely failing.
The #33 recipe, reapplied. Claude path byte-for-byte unchanged. Ships ACTIVE (the broken
behavior fires today).

## Decision-point inventory
1. `getSessionFramework === 'codex-cli'` gate in readJsonlBaseline.
2. findNewestRolloutSync ("which rollout is newest").

## 1. Over-block / 2. Under-block
No blocking surface. CompactionSentinel re-injects a recovery prompt + verifies. The fix
makes verify CORRECT for codex (was: always-fails → redundant re-inject ×3 → false
compaction:failed). Worst case the codex branch returns null = today's behavior. Concurrent
codex sessions: a false-recovery stops re-injection one cycle early (LESS harmful than the
current redundant re-inject); single-session = correct.

## 3. Level-of-abstraction fit
Identical surface to the #33 RateLimitSentinel fix; reuses the same findNewestRolloutSync
helper + the framework-aware readJsonlBaseline pattern. No new subsystem.

## 4. Signal vs authority compliance
[docs/signal-vs-authority.md](../../docs/signal-vs-authority.md). Recovery (re-inject +
verify) is an existing authority surface; this extends the SAME lifecycle to codex, does
not newly elevate authority. No monitoring→blocker conversion.

## 5. Interactions
- Claude sessions: unchanged (gate is codex-only; 22 existing tests pass).
- RateLimitSentinel: independent; both now use findNewestRolloutSync (shared, pure helper).
- Concurrent codex sessions: the account-wide-signal caveat (#33's), less harmful here.

## 6. External surfaces
None new. Reads local codex rollout files. No HTTP route, no external API, no user-facing
vendor strings (CompactionSentinel emits events + console logs only).

## 7. Rollback cost
Low. The codex branch is additive + gated; a PR revert restores the prior (broken-for-codex
but claude-correct) behavior. No flag (active), but the change cannot regress Claude.

## Conclusion
Safe to ship ACTIVE. Strictly-better than the current broken-for-codex behavior
(2nd-pass-verified). Concurrent-session caveat documented (same as #33, less harmful here).

## Second-pass review
Independent reviewer **CONCUR ship-active, NO must-fix.** Verified: Claude path
byte-identical; recipe correctly applied (import + codexHome arg + early return + null-safe);
strictly-better than current broken state (worst case = today's null-return); concurrent
caveat acceptable. Non-blocking: same single-account caveat as #33.

## Evidence pointers
- Unit: `tests/unit/CompactionSentinel-codex.test.ts` (grow→recover, no-grow→fail).
- Claude-unchanged: existing `tests/unit/CompactionSentinel.test.ts` (22 tests pass).
- Spec: `docs/specs/compaction-sentinel-codex-parity.md` (+ `.eli16.md`).
