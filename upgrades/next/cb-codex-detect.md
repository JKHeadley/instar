<!-- bump: patch -->
## What Changed

The Codex adapter's compaction detection and post-compaction producer (context-budget-layered-summaries §9.6 Codex column, §9.1 canary; Phase 1 S16).

- **Evidence first (plan item A1).** Codex rollouts on this machine were measured (Codex CLI 0.156.1, 0.166.0, 0.167.0; 173 entries in a 606-file sample). Codex WRITES an engine-native `compacted` entry for every compaction, with a `window_id` and an empty `message`. So Codex compaction detection is a transcript-channel detection (`supported`), not a synthesized one, and the token_count-drop detector A1 contemplated is not needed and not built.
- **The rollout parser.** `classifyCodexRolloutEntry` classifies the three entry kinds the channel reads (session meta, usage reading, compaction). A forked (subagent) rollout copies its parent's compactions before its own first usage reading; those copies are never counted, and a `window_id` is counted once across rollouts.
- **The `trackContextUsage` caller.** Each usage reading from a Codex topic session's rollout feeds the adapter's `trackContextUsage`: one synthesized pre-compaction notice per compaction cycle at 85% of the window (the engine-reported window when the rollout carries it, 258,400 on the measured version; else the assumed 200K). It is counted as a signal, never as a detection, and is re-armed by the next compaction. The re-arm survives a restart.
- **The post-compaction producer.** `postCompactEmitter` had no producer. The transcript channel now emits the adapter's post-compaction notice on each fresh Codex compaction. Codex exposes no summary, so the notice carries `summary: null` and says so.
- **The canary's Codex group.** `GET /context-budget/sentinel` shows a `codex-cli` group with `marking: "synthesized"`, the engine's capability profile (`healByInjection: false`) and a count of synthesized signals. Its state is the new `counted`: compactions detected and counted, recovery not yet verifiable (the next-prompt seed is a later slice), never `diverged` and never healed by injection.
- **Dev-gated.** Codex sessions join the canary only while `contextBudget.enabled` resolves on (live on a development agent, dark on the fleet), and only where the context-budget sentinel runs. With the gate off the canary's scope is exactly Claude Code's, as before.

## What to Tell Your User

Nothing changes for you. On development agents, when a conversation runs on Codex, I can now see each time Codex compresses that conversation's memory and count it. Before, those compressions were invisible to me.

## Summary of New Capabilities

- Codex compaction detection from the rollout's own `compacted` entry.
- A real caller for the synthesized 85% pre-compaction signal, and a post-compaction producer for Codex.
- A `counted` canary state for an engine whose compactions are counted but whose recovery cannot be verified yet.

## Evidence

- Unit: `tests/unit/codex-compaction-channel.test.ts`, `tests/unit/compaction-canary.test.ts`, `tests/unit/migrate-context-budget-sentinel-row.test.ts`.
- Integration: `tests/integration/context-budget-sentinel-route.test.ts`.
- E2E: `tests/e2e/context-budget-codex-canary-alive.test.ts`, `tests/e2e/context-budget-canary-alive.test.ts`.
