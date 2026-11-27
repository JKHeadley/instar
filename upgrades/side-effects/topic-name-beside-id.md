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
- Ratchet `tests/unit/topic-ref-ratchet.test.ts`: per-file baseline of two remaining bare
  `topic ${…}` renders; one already carries the name beside the id and one is a lifeline log.
  A new non-log site fails.

Size: ~25 source files, ~120 changed lines + formatter + 4 test files. Effort: no spec rounds
(Tier 1), one commit.

## Decision-point inventory

None. Text rendering only; no gate, block, routing or lifecycle decision changes.

---

## 1. Over-block

No block/allow surface.

## 2. Under-block

- Two non-log bare renders remain in the ratchet baseline: the InputGuard prompt already
  gives the name beside the id, and one lifeline diagnostic is internal. Other log-only
  renders are outside the ratchet; they are not a proof that every log line carries a name.
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

## Main-merge review (2026-11-04)

After merging current main, four source files had acquired new bare topic labels: `SessionDrainRunner`, `AgentServer`, `server.ts`, and `WorkYieldRegistry`. They now use the same `topicRef` formatter. `OriginForwardToHolder.heldExpiryItem` also uses it while retaining main's condition key and attention-item shape. This is a Tier 1 wording repair in an existing formatter path. No new gate, block, routing choice, or static judgment heuristic was added; the signal-versus-authority rule in `docs/signal-vs-authority.md` is therefore unchanged.

Over-block: none. Under-block: the two baseline sites described above remain. The formatter is the right layer because all four callers need the same verified local topic name. Interactions: only notice and audit text changes; topic ids, attention condition keys, dedupe keys, transfer decisions, and Telegram delivery remain as before. External surface: an agent or operator may see the topic name beside the id in a transfer reason, held-reply notice, media degradation, or maintenance work label. Multi-machine posture: machine-local registry reads by design, because a serving machine knows the topic names it owns; unresolved names are stated plainly. The changes add no durable state, URL, or new notifier, so they do not create a new one-voice or transfer obligation. Rollback is a revert of this PR; no data migration is needed.

## Scope audit (2026-11-04)

The first baseline included errors, refusal reasons, recovery notices, and command output that
an agent or operator can read. Those are part of the operator's rule, so they now call
`topicRef` too. This includes desktop confirmation, profile transfer disclosure, session
recovery, PromiseBeacon, Telegram sender failures, and API error text. The changed log lines
use the same formatter for consistency. This widens wording coverage only; no delivery target,
ownership decision, or durable key changed. The local resolver can still have no verified name,
in which case the text explicitly says `name unresolved`.

The issues-group refusal text is also read by the legacy relay replay classifier. Its parser
now accepts the old bare-id form plus the new verified-name and unresolved-name forms; unit
coverage checks all three so queued replies retain their replay classification across update.

The full unit run exposed three integration points in the merged branch. The watch-only
maintenance import allowlist now explicitly permits the pure formatter; the held-reply
assertion expects the unresolved-name wording; and the release note remains under
`upgrades/next/` so the release assembler consumes it. All three focused tests pass.

The new GitHub run exposed a runner-specific failure in the existing Claude-key E2E test:
the test's CLI child loaded Config before key handling, and Config required the configured
framework binary. GitHub's runner has no Claude CLI. Main independently fixed this
production defect in PR #2719 while this PR was running. The merge retains main's stronger
test, which runs the CLI with no framework binary on PATH and verifies the key path directly.
This PR's temporary test stub was dropped during conflict resolution.

The later CI run found one memory-recovery test timing out at the default ten-second
limit under a loaded Node 20 shard. The same file passed locally in 2.3 seconds; that
test now allows thirty seconds for the real subprocess checks. The local full integration
run found this host below the media store's five-percent free-disk floor, so three
unrelated media-flow fixtures refused uploads. Those fixtures now supply a healthy disk
reading for their media store instances. Production disk refusal remains unchanged and
retains its separate tests.
