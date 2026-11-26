# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

- The cross-topic activity index (`GET /parallel-work/activities`) is no longer written from conversation alone. When a finished turn makes a concrete action claim ("I'll restart it", "pushing the fix") OR asks the operator to approve an action ("may I restart the Studio?", "please approve the restart"), the action-claim observer now records a durable, secret-scrubbed note for that topic (`{stateDir}/topic-action-notes/<topicId>.json`, new `TopicActionNoteStore`) at the moment the turn finishes — automatically, independent of whether a follow-through commitment opens. A note newer than the topic's latest conversational goal/decision becomes its `focus`; its words join `tags`; every row carries a new `lastAction` field. Fixes CMT-810 (2026-10-14: two sessions gave the operator opposite restart advice because one topic's row still showed a 21-minute-old goal while it was asking for a restart approval).
- New `classifyApprovalRequest` in `action-claim.ts` catches the approval-REQUEST shape the claim classifier correctly ignores. A request writes a note only; it never opens a commitment.
- `ParallelWorkSentinel` is now verifiable: it records `lastTickAt` / `tickCount` / last error, exposes `guardStatus()` + `stats()`, self-registers in the `GuardRegistry` at construction (manifest `expectRuntime: true`, 15-min cadence), and runs an early first tick 30s after boot — so `GET /guards` grades `monitoring.parallelWorkSentinel.enabled` `on-confirmed` from a real tick instead of `on-unverified / not-instrumented` forever. New read surface `GET /parallel-work/sentinel` (503 when the sentinel is dark).
- Config: `parallelWork.actionNotes { enabled: true, windowHours: 24 }` (code default ON; `enabled: false` is the live kill switch; the migrator adds the block without overwriting an operator's value); `monitoring.parallelWorkSentinel.initialTickDelaySeconds` (default 30; 0 disables). CLAUDE.md template + migration gain the awareness bullet.

## What to Tell Your User

Nothing changes in what you see. Behind the scenes, when one of my conversations says it is about to do something concrete, or asks you to approve something like a restart, that fact is now written down for my other conversations to read right away. Before this, my other conversations only knew what a topic had been *talking about*, which could be twenty minutes stale at exactly the wrong moment. The watcher that spots two conversations working on the same thing now also reports its own last run, so I can prove it is actually running.

## Summary of New Capabilities

- `GET /parallel-work/activities` rows now carry `lastAction` (`{ kind: action-claim | approval-request, verb, excerpt, at }`) and an action-derived `focus` when the action is newer than the conversational refs.
- `GET /parallel-work/sentinel` — overlap-councilor runtime: `lastTickAt`, `tickCount`, activities/nudges per tick, last error, cadence.
- `POST /action-claim/observe` responses carry `activityNote` (`null` or `{ kind, verb, deduped }`).
- Config `parallelWork.actionNotes` (`enabled`, `windowHours`); `monitoring.parallelWorkSentinel.initialTickDelaySeconds`.

## Evidence

- Live state read 2026-10-14 (agent Echo, Mac Studio): topic 102965's index row read "The immediate goal is to prevent idle cleanup from shutting down the desk" (updated 14:13 PDT) at the 14:34 restart request and two hours later; `GET /guards` showed `monitoring.parallelWorkSentinel.enabled` as `configEnabled: true, effective: on-unverified, runtime: null, runtimeReason: not-instrumented`.
- Replay test `tests/unit/parallel-activity-index-action-notes.test.ts` reproduces the 14:13 goal → 14:34 approval request → 16:19 read: the row's `focus` becomes `Asked the operator to approve: restart — "May I restart the Mac Studio …"` with `lastAction.verb: restart`, and is still visible at 16:19.
- Tests: 34 unit (classifier 8, store 9, index 6, sentinel instrumentation 5, migrations + template 6), 10 integration (`parallel-work-action-notes-route.test.ts`), 6 e2e (`parallel-work-action-notes-lifecycle.test.ts`, real `AgentServer` boot). Pre-existing suites touched (action-claim route, parallel-activity index, sentinel wiring, guards route + e2e, manifest lint, ConfigDefaults, feature-delivery completeness) pass unmodified.
- Side-effects review with independent second pass: `upgrades/side-effects/parallel-activity-action-notes.md`.
