<!-- bump: patch -->
## What Changed

The Codex adapter's next-prompt seed and its verification suite (context-budget-layered-summaries §9.6 Codex column, §9.1, §16 Phase 1; slice S17).

- **Codex sessions get their context back after a compaction.** Codex has no hook that seeds a session right after it compacts, so the per-prompt hook now carries the seed. On the first Codex prompt after a compaction, the server checks the session's own rollout. The newest `compacted` entry is the compaction, and its `window_id` is the context epoch. The server returns the topic's verified standing packet with a note saying it is delivered with this prompt, and the hook prints it in place of the usual topic briefing.
- **Seeded once per compaction.** The server reads "already seeded" from the rollout itself: Codex records the hook's output as model input, so a seed the model received is never repeated. A delivery Codex dropped is retried once, on the next topic prompt. The hook then acknowledges, which writes the seeded marker. Only the topic's own live Codex session is offered its packet, and only on the first topic prompt after the compaction (one retry). A packet that fails verification is never sent: that prompt gets the usual briefing.
- **Routes.** `POST /context-budget/codex-seed`, `POST /context-budget/codex-seed/ack`, and `GET /context-budget/codex-seed` for the counts.
- **The canary can verify Codex recovery.** A Codex compaction waits for its next topic prompt. It counts as recovered once the seed appears in the rollout as model input, and as diverged if that prompt passed without one. A compaction followed by another before any topic prompt is superseded and is judged neither way. A Codex row stops at `accruing`, because no test compaction is wired for Codex yet.
- **The Codex adapter verification suite.** It runs on one throwaway headless Codex thread and is refused under a channel topic. It records every row of the §9.6 table, measured, per machine, engine and version. The sentinel reruns it whenever the Codex binary's version changes; it is off unless `contextBudget.adapterSuite.enabled` is on.
- **Recorded once on the development machine.** Codex 0.167.1 returned 8 rows supported, 3 partial and 5 absent (4 of those unmeasured). It found that this Codex has PreCompact, PostCompact and post-compaction SessionStart hooks and a usable compaction-window setting, which the spec had expected to be missing. See `docs/specs/reports/context-budget-codex-adapter-suite.md`.
- **Dev-gated.** Everything here sits behind `contextBudget.enabled` (live on development agents, dark on the fleet). With it off, the hook prints exactly what it printed before.

## What to Tell Your User

On development agents, a conversation running on Codex now picks up where it left off after Codex compresses its memory. The next message carries a short summary of what that conversation is about, its decisions, and your recent words, so you don't have to repeat yourself. Nothing changes on other agents.

## Summary of New Capabilities

- Next-prompt seed delivery of the standing packet for Codex sessions, once per compaction.
- Canary verification of Codex compaction recovery.
- A re-runnable Codex adapter verification suite, with a recorded result for Codex 0.167.1.

## Evidence

- Unit: `tests/unit/codex-seed.test.ts`, `tests/unit/codex-compaction-channel.test.ts`, `tests/unit/ContextBudgetSentinel.test.ts`.
- Integration: `tests/integration/context-budget-codex-seed-route.test.ts`, `tests/integration/context-budget-sentinel-route.test.ts`.
- E2E: `tests/e2e/context-budget-codex-seed-alive.test.ts`, `tests/e2e/context-budget-codex-canary-alive.test.ts`.
- Live run: `docs/specs/reports/context-budget-codex-adapter-suite.result.json`.
