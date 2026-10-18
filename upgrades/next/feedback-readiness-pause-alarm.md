# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The feedback drain's readiness authority demotes itself to `proposal-only` on three brakes (`readiness-spend-brake`, `readiness-schema-provenance-or-routing-failure`, `readiness-authority-repeated-invocation-failure`), and only the operator's dashboard PIN restores it. That boundary is deliberate and unchanged. The demotion was silent: on the Mac Studio it fired at 2026-10-14T16:30:21Z after three consecutive `Codex CLI error (exec --json, exit 1)` runs, and the drain produced no work items for four days with no notice to anyone. While paused, every drain tick is refused at the gateway (403 `current registered readiness agent required`), so nothing inside a tick ever ran to notice.

- **`FeedbackDrainService`** gains an optional `raiseAttention` dependency and a private `alarmIfPaused(authority)`: when the authority's posture is `proposal-only` it raises ONE attention item, id `feedback-drain:readiness-paused:<authorityId>:<generation>`, title "Feedback sorting is paused", the existing `brakePlainWords(reason)` text, and the restore path (approve the sorting model again on the dashboard Feedback Drain tab; nothing restores it automatically). Priority HIGH for the wrong-model/prompt brake, NORMAL otherwise. Called right after each of the three `demoteAuthority` calls, and from the tick's authority-unavailable branch.
- **`FeedbackDrainService.notifyIfReadinessPaused()`** (new, fire-and-forget) is called by `FeedbackDrainTickProxy.acceptOwned` on its 403 refusal, on the canonical owner only, so a pause that predates the process or whose first notice failed is told by the next refused tick.
- Dedup: an in-process set plus the durable attention store's own id idempotency (`TelegramAdapter.createAttentionItem` returns the existing item for a known id). Enqueue errors are swallowed (`@silent-fallback-ok`) and retried by the next refusal.
- `AgentServer` wires `raiseAttention` to `telegramAdapter.createAttentionItem`, the same funnel triage uses.
- CLAUDE.md template and `migrateClaudeMd` gain the "A paused sorter is announced once" bullet under the Feedback Readiness Authority section.

No change to the brakes, the PIN restore path, or any authority state.

## What to Tell Your User

If my feedback sorting ever pauses itself (it does that on purpose when its spending cap is hit, when a different model answers, or after three runs in a row without a usable answer), you'll now get one notice in your Attention topic saying why and that approving it again on the dashboard is what restarts it. Before, it paused silently, which is how it sat stopped for four days in October without anyone knowing.

## Summary of New Capabilities

- One plain-English attention notice when the feedback sorter pauses itself, naming the reason and the restore step.

## Evidence

- Reproduction (live, Mac Studio): drain store `drain_audit` rows 2042–2051 (eight `call-failed` readiness calls on 2026-10-14) and row 2052 (`authority active → proposal-only readiness-authority-repeated-invocation-failure` at 16:30:21Z); `GET /feedback-factory/drain/status` on 2026-10-18 showed `lastRun` 2026-10-14T16:30Z and no attention item existed.
- Unit: `tests/unit/feedback-factory/drain-readiness-pause-alarm.test.ts` (three no-usable-answer ticks → exactly one NORMAL item with the plain reason and restore path, no repeat and no model call on later ticks, authority stays paused; wrong-model → one HIGH item at once; a pre-existing pause is told on the first tick; a failed enqueue is retried once and never throws; an active authority raises nothing), `tests/unit/readiness-pause-alarm-awareness.test.ts` (template placement, migration once + idempotent).
- E2E: `tests/e2e/feedback-drain-readiness-brake.test.ts` boots the production `AgentServer` wiring and runs the shipped `feedback-factory-process` job script: the wrong-model pause raises one HIGH item and the following refused run does not repeat it; with the in-process memory cleared (a restart), the next refused run raises the same id once and the authority stays `proposal-only`.
