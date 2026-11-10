<!-- bump: patch -->
## What Changed

Groundwork for folding long conversations: Instar can now restore a prepared briefing into a session right after it injects `/clear`. A new SessionStart `clear` hook (`clear-seed.sh`, installed and registered on every Claude Code agent) prints a staged packet only when one was staged for exactly that Instar session, under a live lock, with a matching hash; it claims it once and records a seeded marker. A human-typed `/clear` stays exactly as before (nothing prints). The server's internal control-command path now accepts `/clear` as well as `/compact`. Nothing stages a packet yet; the fold coordinator that does is a later slice of the same spec (Context Budget: Layered Summaries).

## What to Tell Your User

Nothing changes for you yet. This is the first piece of the machinery that will let a long conversation shrink its own working notes without losing what matters.

## Summary of New Capabilities

- Clear-and-seed rung of the fold ladder, built and proven on a real Claude Code `/clear`.
- Rollback: `contextBudget.compactionRecovery.enabled: false`.

## Evidence

- `tests/unit/clear-seed-hook.test.ts` (15: seeds once and claims; human clear silent; expired lock, hash change, another Instar session, no INSTAR_SESSION_ID, non-clear source, path escape, switch off, non-Claude engine all silent; agent-home root for worktrees; writer refusals; settings migration idempotent).
- `tests/unit/session-manager-pending-inject-wiring.test.ts` (`/clear` through the fenced control path; a command outside the closed set refused).
- L7: real Claude Code 2.1.321 `/clear` with a staged packet — the model answered the packet-only token; second `/clear` without a packet — the model answered NONE. Measured: `/clear` starts a new Claude session id and transcript.
