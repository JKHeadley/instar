# Side-Effects Review — profile restarts stop wiping out freshly started tasks

**Version / slug:** `profile-restart-keeps-spawn-brief`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see the end of this file)`

## Summary of the change

Echo Bugs topic 10000001430. A session started with `POST /sessions/spawn` and a `topicId` was restarted by the topic-profile boot sweep at the next server boot ("this topic's pinned profile wasn't applied before my last restart"). The restart was a fresh CONTINUATION that rebuilt context from chat history, which never held the spawn prompt, so the new session idled and the task was lost. Root cause: the direct spawn route neither resolved the topic profile nor recorded what it launched, and `bootReconcileSweep` read a missing `lastApplied` record as divergence. Every non-orchestrator spawn path that skipped `recordSpawnSuccess` was therefore restarted at every boot. The profile audit log shows 20+ `boot-sweep-armed` rows from 2026-11-01 to 2026-11-03.

Three changes, one class:

1. `POST /sessions/spawn` with a topic resolves the topic profile (via `resolveTopicSpawnProfile`, the same resolver `spawnSessionForTopic` uses) for framework and model when the request leaves them unset, then calls `orchestrator.recordSpawnSuccess` with what it actually launched. thinkingMode/effort are recorded as null because this path has no launch control for them.
2. `bootReconcileSweep` skips a live session with no `lastApplied` record (audit `boot-sweep-unknown-applied`) instead of arming a respawn.
3. A new `TopicSpawnBriefStore` keeps the direct spawn's prompt, keyed by topic and tmux session. The orchestrator's spawn directive now names `replacedSessionName`. On a `continuation` respawn the server's spawn port passes the brief to `spawnSessionForTopic` (`carriedBrief`), which adds it to the bootstrap before the handoff instruction. The brief is then re-keyed to the new session.

Tier 1, declared. 5 source files, about 200 LOC of source plus tests in all three tiers. One commit attempt; no spec rounds (narrow fix under the existing TOPIC-PROFILE-SPEC, whose §8 boot-sweep text is updated).

## Decision-point inventory

- Boot sweep "restart this session?" — modify — a missing record is no longer a reason to kill.
- Direct spawn's model/framework — modify — profile fills unset axes; explicit request values still win.
- Respawn bootstrap content — add — a carried brief on continuation respawns of the brief's own session.

## 1. Over-block

The boot sweep now kills fewer sessions. A session that really is on the wrong profile and has no record (spawned before this release, or by an unknown path) is no longer corrected at boot. It is corrected at its next natural spawn, and any pin change made while it is live still goes through the normal respawn path. That trade is deliberate: an unknown launch is not evidence, and acting on it destroyed live work.

## 2. Under-block

- A direct spawn into a topic whose profile pins thinkingMode or effort records null for those. The boot sweep will still see a real difference and restart the session once to apply them. That restart now carries the brief, so the task survives.
- A crash or compaction recovery that restarts a direct-spawned session goes through `spawnSessionForTopic`, so it clears the brief rather than carrying it. That recovery already rebuilt context from chat history alone, so the brief was lost there before this change too. Recovery continuity is outside this profile-restart fix and is filed as feedback.
- Other spawn paths that bind a topic without going through `spawnSessionForTopic` or this route (if any exist) are covered by change 2. With no record, they are left alone rather than killed.

## 3. Level-of-abstraction fit

Profile resolution stays in the one resolver. The route only fills unset axes, mirroring `spawnSessionForTopic`. Recording uses the existing `recordSpawnSuccess` entry point. The brief carry is in the server's spawn port, the only place that has both the replaced session and the bootstrap builder.

## 4. Signal vs authority compliance

This removes kill authority from a no-evidence case. It adds no new blocking. The boot sweep keeps its authority only for recorded divergence.

## 4b. Judgment-point check

None added.

## 5. Interactions

- `recordSpawnSuccess` also resets the §10.4 breaker and clears the suppression marker for the topic. A successful direct spawn is a successful spawn, so this is the right reading. The orchestrator-initiated path is unaffected (it does not go through this route).
- The `ultracode` framework guard now reads the profile-resolved framework, so a codex-pinned topic refuses `ultracode: true` honestly instead of launching on claude-code against its pin.
- Brief carry happens only on `continuation` respawns. A `resume` respawn keeps the whole transcript, so the prompt is already there. Briefs are matched to the replaced session's tmux name. Topic sessions reuse one name, so that match alone is not enough: every spawn through `spawnSessionForTopic` that the orchestrator did not start clears the topic's brief. A later natural or user-driven session therefore never inherits a finished task.
- `spawnSessionForTopic` ignores `carriedBrief` when a user message drives the spawn, or on `silentStart`.

## 6. External surfaces

Direct topic spawns may now launch on a different model than before (the topic's pin instead of the account default). That is the intended behaviour: the profile is what the operator asked for. New state: small JSON files under `.instar/state/topic-spawn-briefs/`.

## 6b. Operator-surface quality

The misleading "pinned profile wasn't applied" notice stops firing for sessions that just started on the right profile.

## 7. Multi-machine posture (Cross-Machine Coherence)

machine-local BY DESIGN: the brief and the `lastApplied` record describe a tmux session on this machine, and the orchestrator side-state is already machine-local. A topic moved to another machine is spawned there by that machine's spawn path, which records its own launch.

## 8. Rollback cost

Revert the commit. Leftover brief files are inert.

## Conclusion

Safe to ship. It removes a kill path that had no evidence behind it, closes the reason that path fired, and keeps the task for the restarts that are still legitimate.

## Evidence pointers

- `logs/topic-profile-changes.jsonl` 2026-11-03: `boot-sweep-armed` 10000001407 at 05:45:05Z leading to `respawn-applied continuation fresh` at 06:08:33Z. `boot-sweep-armed` 10000001426 at 07:17:09Z leading to `respawn-applied continuation fresh` at 07:17:20Z.
- `logs/server.log`: 10000001426 was bound by the direct spawn route at 07:03:40Z with no `[spawnSessionForTopic]` line, i.e. no profile record.
- Tests: `tests/unit/TopicProfileOrchestrator.test.ts` (unknown-applied is left alone; a matching record is not restarted; the respawn names the replaced session), `tests/unit/TopicSpawnBriefStore.test.ts`, `tests/unit/session-spawn-topic-binding.test.ts` (`resolveTopicSpawnProfile`), `tests/unit/topic-profile-server-wiring.test.ts` (port carries the brief on continuation only, same store instance as the routes), `tests/integration/sessions-spawn-topic-profile.test.ts`, `tests/e2e/topic-profile-direct-spawn-lifecycle.test.ts`.

## Class-Closure Declaration

- defect class: `unbounded-self-action`
- closure: `structural`
- reason: the self-triggered restart is now gated on recorded evidence. The route that produced the missing evidence records it.

## Second-pass review

Independent subagent, 2026-11-03. **Concern raised:** topic-path sessions reuse one tmux name (built from the topic name) and briefs never expired. A brief re-keyed to that name would be carried into a later, unrelated session's profile respawn, bringing back a finished task. **Fixed:** `spawnSessionForTopic` clears the topic's brief on every spawn the orchestrator did not start (`TopicSpawnBriefStore.clear`, through SafeFsExecutor). Tests: `clear` in the store test, plus a wiring assertion. The reviewer's other notes were accepted as documented behaviour and need no change. In each, the restart is a legitimate one and the brief is now carried: a local-model binding or a thinking/effort default forces one boot restart, and an explicit request override is switched back to the pin. The reviewer judged the null-record skip safe, because the pin-change path still treats a missing record as divergence. The reviewer also judged the ultracode guard and the bootstrap formatting correct.

Re-check after the fix (same reviewer): **Concur.** The clear runs only after the new session spawned. Orchestrator respawns still carry and re-key the brief. The direct route does not call `spawnSessionForTopic`, so a freshly recorded brief is not wiped.
