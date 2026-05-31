---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13435; independent 2nd-pass review CONCUR ship-active, no must-fix)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — codex compaction-recovery is now verified correctly (fixes a real codex bug)

CompactionSentinel re-injects a recovery prompt to a session that didn't come back cleanly
after compaction, then confirms recovery by watching the session's transcript grow. It only
knew where Claude keeps transcripts, so for a codex session it found nothing → concluded
"still stuck" → re-injected the recovery prompt up to 3 times (stacking confusing restart
prompts on the user's real message — a known disruptive loop) and then falsely reported a
recovery failure, every single codex compaction.

Now it reads the codex session's actual rollout (the same account-wide "is codex producing
output again?" signal used for the codex rate-limit fix, no fragile per-session id). Claude
behavior is byte-for-byte unchanged. This is the second of the two sentinels that were codex-
blind (the rate-limit one shipped previously).

## What to Tell Your User

If you run a codex agent that gets compacted on a long task, it will now recover cleanly
instead of getting hit with a burst of confusing restart prompts and a false "recovery
failed." Nothing to configure — it is simply correct now.

## Summary of New Capabilities

- `CompactionSentinel` recovery-verification is codex-aware: for codex sessions it reads the
  newest codex rollout's growth (via `findNewestRolloutSync`) instead of the Claude transcript.
- New deps `getSessionFramework` + `codexHome`; Claude path untouched.

## Evidence

- Repro: a codex session that recovers from compaction is wrongly re-injected ×maxInjectAttempts
  then marked `compaction:failed`, because `readJsonlBaseline` returned null for codex.
- Before/after: before — codex verification always null → false-fail; after — reads the codex
  rollout's growth → `compaction:recovered`.
- Unit: `tests/unit/CompactionSentinel-codex.test.ts` (rollout grows → recovered; never grows
  → failed). Claude-unchanged: existing `tests/unit/CompactionSentinel.test.ts` (22 tests pass).
- `tsc --noEmit` clean; `npm run lint` clean.
- Independent second-pass review: CONCUR ship-active, NO must-fix (verified Claude byte-
  identical + strictly-better than the current broken-for-codex behavior). Same single-account
  concurrent-codex-session caveat as the rate-limit fix (less harmful here; single-session correct).
- Spec: `docs/specs/compaction-sentinel-codex-parity.md` (+ `.eli16.md`).
- Side-effects: `upgrades/side-effects/compaction-sentinel-codex-parity.md`.
