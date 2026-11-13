# The session build-context store drops expired rows when it is written

<!-- bump: patch -->

## What Changed

`SessionBuildContextStore` keeps one row per tmux session (where it was spawned, where it is working), so a restarted session can be told which worktree it was in. A row older than six hours is never restored, but nothing removed it: every session ever spawned kept its row.

`record()` now writes the store without the rows past the max age (`withoutExpired`). Reads are unchanged. An unchanged session still writes nothing.

One consequence: a session that has stayed in one worktree past the max age loses its row at the next write, and the monitor's next pass records it again as current. Before, that row stayed expired and a restart did not restore a worktree the session was still in.

## What to Tell Your User

Nothing changes that you will see. A file the agent re-read many times a minute had grown without limit; it now stays small, which removes a steady drag on how quickly the agent answers.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Build-context store pruned of expired rows on write | Automatic |

## Evidence

Studio, 2026-11-13: `state/session-build-context-<machine>.json` held 32,378 rows in 8,209,026 bytes; 32,288 rows (99.7%) were past six hours, the oldest 2,078 hours. In every caller-attributed profile of the server that morning, `StateManager.get <- SessionBuildContextStore.readAll <- record <- SessionManager.recordBuildContextAsync` was the largest JS consumer: 4.7% of samples in a quiet 45-second profile (15:31Z), 10.5% during a freeze capture (15:56Z). Pruning the file by hand to its 90 live rows took it to 24,458 bytes.

Tests: `tests/unit/session-build-context-store.test.ts`, 4 new (10 in the file): a write drops rows past the max age and keeps a row at exactly the max age; a 5,001-row store shrinks to its live rows on the next write; an unchanged session writes nothing; a long-lived session whose row was pruned is recorded again as current. Not run locally: `tests/integration/session-build-context-respawn.test.ts` (needs the suite slot; Local Verify runs it).
