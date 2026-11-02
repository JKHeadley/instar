# Side-Effects Review — a topic's name always travels with its id

**Version / slug:** `topic-name-beside-id`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `not required (wording only; no gate, sentinel, lifecycle or dispatch decision touched)`

## Summary of the change

Tier 1 (wording in server-authored text; a revert fully undoes it). Operator rule (Justin,
2026-11-02, verbatim): "An Instar agent should ALWAYS have access to the topic name if they have
access to the topic ID. The name and ID should be inseparable." Live case: a peer's session was
told "topic 11882, the topic for echo" and told its user it could not see the topic name, though
the registry held "🤝 echo".

- New `src/messaging/shared/topicRef.ts`: `topicRef` / `TopicRef` / `telegramTopicRef` /
  `topicNameFor` render `topic 11882 "🤝 echo"` or `topic 11882 (name unresolved)`. The name is
  the caller's, else the registry's (`setTopicNameResolver`, wired at boot in `server.ts` to the
  live `TelegramAdapter.getTopicName`), accepted only through `verifiedEntityName` and sanitized
  with the existing `sanitizeTopicName` (≤120 chars).
- `buildInjectionTag` (`src/types/pipeline.ts`): the `[telegram:N …]` prefix now always carries the
  name (registry fallback) or ` (name unresolved)`; the long-message reference tag passes the name.
- Threadline session text: `TopicLinkageHandler` notice lines and `ThreadlineRouter` spawn-prompt
  topic hint; hub topic candidates (`HubIntentClassifier`, `hubCommands`) fall back to the
  registry name instead of an invented `topic N`.
- Notices/attention items and session-facing prompts in `routes.ts`, `server.ts`, `SessionReaper`,
  `AutonomousLivenessReconciler`, `OwnershipReconciler`, `OriginForwardToHolder`,
  `OutboundAdvisory`, `MentorAutonomousGuardian`, `StaleOwnerReleaseEngine`, `PrHandLease`,
  `TelegramSpendTopicChannel`, `ReapNotifier`, `ReapNoticeDrain`, `TopicReachabilityVerifier`,
  `SeamlessOrchestratorEngine`, `ScopeVerifier`, `ColdStartFallbackReply`, `SessionManager`,
  `TelegramAdapter` (session list).
- Ratchet `tests/unit/topic-ref-ratchet.test.ts`: per-file baseline of remaining bare
  `topic ${…}` renders (35, all thrown errors / refusal reasons / internal strings); a new site fails.

Size: ~25 source files, ~120 changed lines + formatter + 4 test files. Effort: no spec rounds
(Tier 1), one commit.

## Decision-point inventory

None. Text rendering only; no gate, block, routing or lifecycle decision changes.

---

## 1. Over-block

No block/allow surface.

## 2. Under-block

- 35 bare renders remain (errors, refusal reasons, degradation messages, CLI output). Listed in the ratchet baseline, which only lets them shrink.
- A topic the registry has never named shows "(name unresolved)" until the adapter learns its name (rename events, startup backfill).
- Processes with no Telegram adapter (no Telegram configured) render every topic as unresolved.
- Attention item ids, condition keys and log lines are unchanged (ids, not prose).

## 3. Level-of-abstraction fit

One formatter in `messaging/shared`, beside the existing verified-identity rule it reuses, and one
late-bound resolver wired once at boot, so no component needs a new dependency.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check

No judgment point.

## 5. Interactions

- `[telegram:N` parsers (`InputGuard`, `SessionManager` tag match, `telegram-topic-context.sh`) anchor on `^\[telegram:(\d+)`; the name / marker follows the id, so they are unaffected. `InputGuard` provenance check compares ids only.
- The long-message reference tag and the bare tag are no longer byte-identical to the old `[telegram:N]` (tests that pinned those bytes were updated).
- The topic name is peer- or user-influenced text entering session prompts and LLM classifier prompts; it is sanitized exactly like the existing prefix name.
- Dedup on notice text: identical held-reply/attention bodies still dedupe (the name is stable per topic).

## 6. External surfaces

User-visible wording in attention items and notices gains the topic name. Session prompts gain the
name. Nothing sent to peers changes. No config switch (wording only; a revert is the rollback).

## 6b. Operator-surface quality

Attention titles become longer by the topic name; they stay one line.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine renders from its own adapter's registry, which already
replicates names through the existing topic-registry paths. A standby that has not yet learned a
name says "(name unresolved)" rather than guessing.

## 8. Rollback cost

Revert the PR; no persisted state, no migration.

## Conclusion

Wording-only change with a structural ratchet against regression.

## Evidence pointers

- tests/unit/topic-ref.test.ts
- tests/unit/topic-ref-ratchet.test.ts
- tests/integration/threadline/topic-name-beside-id.test.ts
- tests/e2e/topic-name-beside-id-alive.test.ts

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `n/a`
- **`closure`** — `n/a`
- **reason** — rendering change; no self-triggered action.
