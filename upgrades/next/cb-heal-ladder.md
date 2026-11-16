<!-- bump: patch -->
## What Changed

The compaction canary can now fix what it finds (context-budget-layered-summaries §9.1; Phase 1 S11). It applies only where the ContextBudgetSentinel is on (`contextBudget.sentinel.enabled`, default off), the context-budget layers are on (`contextBudget.enabled`, dev-gated), and compaction recovery is on.

- **One context epoch.** Every writer and reader of the seeded marker now derives the epoch the same way: the compact-boundary entry's id after a compaction, the fold id after a fold, the spawn id otherwise. The compaction hook still leaves the epoch for the server to bind (it runs before the boundary is written); a test drives the real hooks and the server writer and shows they agree.
- **The server writes the seeded marker** after it delivers a compaction's context itself (the idle-gated fallback, or a heal). A server marker only ever covers its own compaction.
- **The heal ladder, by cause.** For each compaction the canary finds without its recovery:
  - the hooks are not installed ⇒ the hook and settings migration re-runs;
  - the hooks are installed but the briefing never reached the session (missing or cut to a preview) ⇒ the conversation's standing packet is re-staged and delivered once, at an idle prompt, through the same idle-gated path as the fallback, with a preamble that tells the session not to reply about it;
  - anything else (session gone, superseded, no packet to re-seed, a press with no compaction) ⇒ recorded only.
  Brakes: one episode per machine, session and epoch; at most 3 attempts (10 min, then 1 h apart) within 30 minutes; at most 3 runs per session per day; 3 fixes of the same cause in a day stop that cause and raise one Attention item. A completed fix restarts the canary's verification epoch.
- **The synthetic press.** The sentinel presses `/compact` on a throwaway session (named `cb-press-…`, bound to no channel, not a job, idle) so the canary has its positive control and can reach `healthy`. It never presses a conversation session. At most 3 a day, an hour apart, and only while the canary lacks a positive control.
- `GET /context-budget/sentinel` now shows the ladder's recent decisions, open breakers and the press's last outcome.

## What to Tell Your User

Nothing changes for you unless the context-budget watcher is switched on (it is off by default). Where it is on, if a conversation loses its place after its memory is compacted and the usual briefing did not reach it, the agent now notices and quietly hands that conversation its context back once, at a moment it is not busy. If the same problem keeps happening, it stops retrying and tells you once.

## Summary of New Capabilities

- A heal ladder by cause for missed post-compaction recovery, bounded by the SelfHealGate, with a same-cause breaker.
- A gated synthetic compaction press on throwaway sessions, the canary's positive control.
- A shared context-epoch derivation and a server-side seeded-marker writer.

## Evidence

- Unit: `tests/unit/context-epoch.test.ts`, `tests/unit/canary-heal-ladder.test.ts`, `tests/unit/synthetic-press.test.ts`, `tests/unit/CompactionSentinel-heal-reinject.test.ts`.
- Integration: `tests/integration/context-budget-canary-heal.test.ts`.
- E2E: `tests/e2e/context-budget-heal-ladder-alive.test.ts`.
