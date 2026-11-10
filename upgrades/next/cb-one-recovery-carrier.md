<!-- bump: patch -->
## What Changed

After a compaction, the session-start hook now records that it delivered the recovery context (a small marker under `.instar/state/context-layers/_seeded/`), and the server's `CompactionSentinel` waits briefly for that marker and stands down when it appears, instead of injecting a second recovery copy. If no marker appears within 30 seconds of the compaction finishing, the server path runs once as before. The CLAUDE.md "Compaction Survival" sentence now names the recovery block a session should see. Second slice of the Context Budget: Layered Summaries spec; same switch, `contextBudget.compactionRecovery.enabled`.

## What to Tell Your User

After a long conversation is compacted, I get my briefing back once, not twice, so the recovery doesn't bury your last message under duplicate context.

## Summary of New Capabilities

- One recovery copy after a Claude Code compaction, with the server as the fallback when the hook didn't deliver.
- Rollback: `contextBudget.compactionRecovery.enabled: false`.

## Evidence

- `tests/unit/CompactionSentinel-seed-carrier.test.ts` (seed stands down; fallback 30 s after the boundary; fallback at the max wait; stale and prior-compaction markers refused; epoch bound to the boundary id; switch off, non-Claude engine and absent deps keep today's path; marker reader rejects unsafe ids).
- `tests/unit/session-start-source-routing.test.ts` (marker written with boundary epoch and 0600; none on failed or empty seed, unsafe id, switch off; written under the agent home for worktree sessions).
- `tests/unit/PostUpdateMigrator-compactionSurvivalSentence.test.ts` (migration idempotent; template corrected).
- L7: real Claude Code 2.1.321 `/compact` wrote the marker; replaying that transcript and marker through the sentinel gave 0 server injects, epoch = the real boundary uuid.
