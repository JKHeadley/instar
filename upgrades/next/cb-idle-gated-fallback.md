<!-- bump: patch -->
## What Changed

When a Claude Code session's own post-compaction briefing does not arrive, the server's backup briefing no longer types into the session straight away. It is saved in the pending-injects ledger (`.instar/state/pending-injects/`, its own record, never replayed by the generic boot sweep) and delivered only when the session is idle at a ready prompt, checked every 2 seconds for up to 5 minutes, once per compaction. A late hook briefing withdraws it; a session that keeps working through the 5 minutes is left alone; a server restart picks it up again under the same check (or reports it lost if it is older than 15 minutes). Slack sessions and the switch-off path keep the previous behaviour. Same switch as the rest of this work: `contextBudget.compactionRecovery.enabled`. Sixth slice of the Context Budget: Layered Summaries spec.

## What to Tell Your User

If my automatic briefing after a compression ever fails, the backup copy now waits for a quiet moment instead of landing in the middle of my work, and it is not lost if my server restarts.

## Summary of New Capabilities

- Idle-gated, restart-safe, once-per-compaction server fallback for post-compaction context.
- Rollback: `contextBudget.compactionRecovery.enabled: false`.

## Evidence

- Unit `tests/unit/CompactionSentinel-idle-gated-fallback.test.ts`; integration `tests/integration/compaction-idle-gated-fallback-wiring.test.ts` (real SessionManager predicates and boot sweep); e2e `tests/e2e/compaction-idle-gated-fallback-lifecycle.test.ts` (real disk and timers across a restart, plus server wiring check).
