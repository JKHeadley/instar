# Side-Effects Review — mentor cycle smoothness (capture + busy-gate)

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Recipient side. The two
fast-follows from the live round-trip: reply-capture reliability + the
remote-mentee safe-window.

**Change:** new `src/monitoring/SessionReplyExtractor.ts` (pure extractors) +
`src/server/AgentServer.ts` (`extractMenteeReplyFromTranscript` helper, wired
into the mentee handler as transcript-first/tmux-fallback; `isMenteeBusy`
gates on OutstandingPromptTracker) + unit tests.

## What changed
1. `extractCodexFinalMessage` / `extractClaudeFinalMessage` — pure, tolerant
   parsers returning the final assistant prose (null when absent).
2. `extractMenteeReplyFromTranscript(session, spawnTs)` — codex: newest rollout
   written ≥ spawn → task_complete.last_agent_message; claude: the
   `<claudeSessionId>.jsonl` under ~/.claude/projects → last assistant text.
3. Mentee handler: after the bounded-wait, prefer the transcript reply; keep
   the existing capture-while-alive tmux read as the only fallback.
4. `isMenteeBusy`: `!getOrCreateMentorOutstanding().canSendTo(menteeAgent).ok`
   instead of Echo's local session count.

## The seven questions
1. **Over-block.** isMenteeBusy now blocks LESS (only when a real prompt is
   outstanding) — it was over-blocking before (always busy). Correct direction;
   the anti-ping-pong invariant is preserved (one outstanding prompt per mentee).
2. **Under-block.** The outstanding-prompt gate still prevents concurrent
   prompts to the same mentee. Transcript reading is read-only (no new writes).
3. **Level-of-abstraction fit.** Extractors are pure + isolated; the helper
   reuses findRecentRolloutFiles (existing). isMenteeBusy reuses the existing
   tracker. No new infrastructure.
4. **Signal vs authority.** Extractors are pure signal; the handler decides.
   isMenteeBusy is a gate input to the existing safe-window decision.
5. **Interactions.** Reads ~/.codex/sessions + ~/.claude/projects (read-only).
   Reuses OutstandingPromptTracker (shared with deliverToMentee — consistent
   semantics). No new shared mutable state.
6. **External surfaces.** None new. mentor-replies.jsonl now carries clean
   prose instead of stream JSON (content-quality change, same schema).
7. **Rollback cost.** Trivial — revert restores tmux-only capture + the local
   session-count busy check.

## Testing
10 new unit tests (SessionReplyExtractor) green; mentor-runner + mentor/mentee/
inbox suites green; tsc clean. Live tick-driven round-trip with clean-prose
capture verified post-release (the autonomous run's completion criterion).

## Migration parity
No config keys, no state schema change. Pure code. No PostUpdateMigrator change.
