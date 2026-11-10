<!-- bump: patch -->
## What Changed

The session-start hook now reads which lifecycle event fired from the `source` field Claude Code passes in its stdin JSON, instead of `CLAUDE_HOOK_MATCHER`, which Claude Code never sets. Before this, every session start was treated as a fresh startup, so the compaction-recovery step (identity, topic briefing, recent messages) never ran after a compaction. A Claude Code start with no readable source still gets the startup orientation and is recorded as a `compaction-recovery-source` degradation. Codex sessions and agents with `contextBudget.compactionRecovery.enabled: false` keep the old behaviour. First slice of the Context Budget: Layered Summaries spec.

## What to Tell Your User

After a long conversation is compacted, I now get my topic briefing and the recent messages back automatically. Before this fix that step silently never happened, which is one reason I could lose the thread after a compaction.

## Summary of New Capabilities

- Compaction recovery runs after every Claude Code compaction.
- A start whose event can't be read is recorded on the health page instead of passing silently.
- Switch for rollback: `contextBudget.compactionRecovery.enabled` (default on).

## Evidence

- `tests/unit/session-start-source-routing.test.ts` (7 cases: compact, startup, legacy env fallback, unreadable source, Codex, switch off, a never-closing stdin pipe bounded).
- `tests/integration/session-start-source-unknown-route.test.ts` (real AgentServer: degradation recorded, ordinary SessionStart not, bearer required).
- L7 before/after with real Claude Code 2.1.321 and a real `/compact`: installed hook 0 recovery blocks, new hook 1.
