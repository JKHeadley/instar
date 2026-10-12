# Side-Effects Review — A2A reply into a reaped topic session (ACT-091)

**Version / slug:** `threadline-reaped-topic-respawn`
**Date:** `2026-10-11`
**Author:** `Echo (builder)`
**Second-pass reviewer:** `independent general-purpose reviewer subagent`

## Summary of the change

A topic-bound Threadline reply whose topic session was idle-reaped was acked to the peer and then dropped: `TopicLinkageHandler.tryRouteReplyToTopic` set `resume-pending` without waking anything, `ThreadlineRouter` reported `resumed: true`, and the relay logged "Resumed session". Files: `src/threadline/topicRespawnHook.ts` (the dead-topic delivery decision, `createThreadlineTopicRespawn`), `src/core/SpawningTopicsRegistry.ts` (`waitUntilClear`), `src/threadline/TopicLinkageHandler.ts` (new optional `respawnTopicSession` + `isTopicSpawning` deps, new `respawn-inject` delivery mode), `src/threadline/ThreadlineRouter.ts` (honest `delivered`/`resumed`, logs the real mode; the per-thread spawn guard no longer refuses a topic-linked reply during a respawn), `src/threadline/autoAck.ts` (`deferSend`, `settleDeferredRelayAck`, the non-promising `NO_REPLY_ACK_MESSAGE`), `src/commands/server.ts` (the `_threadlineTopicRespawn` hook in `wireTelegramRouting`, the dep wiring, the deferred ack and the honest relay logs), `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` (awareness card + shadow marker).

## Decision-point inventory

- `TopicLinkageHandler` delivery-mode choice — modify — the "registered but not alive" branch now respawns (when the dep is wired) instead of `resume-pending`; refused/failed → `failure-visible`.
- `ThreadlineRouter` topic-linkage result mapping — modify — `delivered`/`resumed` follow what a live session received.
- Relay auto-ack send — modify — deferred for topic-bound replies until routing reports delivery; a warrants-gate no-reply exit sends the non-promising "Message received." ack instead of none.
- In-flight spawn handling — add — a reply arriving while the topic is already respawning waits for that spawn (bounded, 150 s) and is then typed into the live session, instead of being surfaced as `spawn-in-progress`.
- Session spawn admission — pass-through — the hook runs the same checks as the Telegram dead-session path: ownership re-check, G3 lease gate (`g3ShouldSpawnLocally`), death classification (`classifySessionDeath`), the SpawnAdmission checkpoint (new journal-only callsite `threadline-topic-respawn`) and the `spawningTopics` guard. No new admission rule.

---

## 1. Over-block

A topic-bound reply that routing delivers to no live session gets no ack (previously it got one promising a reply that never came — the intended change); the peer's tracker keeps it awaiting-ack, which is accurate. A reply the warrants gate suppresses gets the non-promising "Message received." ack (Dawn's review point 2 — without it the sender's health read would show a stuck channel for a message that was received and deliberately not answered). A reply during an in-flight spawn waits up to 150 s; only a wedged spawn past that bound surfaces it as `spawn-in-progress`. No legitimate message is blocked from delivery.

## 2. Under-block

- A respawn that succeeds but whose woken session then fails to answer still counts as delivered — the same bar as `live-inject` (consumed by a live session).
- Non-topic-bound paths (pipe, listener, cold spawn) still ack before routing, as before; a cold-spawn denial on those paths can still ack a message that is only queued. Out of this bug's path; recorded here so it is not mistaken for covered. <!-- tracked: ACT-091 -->
- If the respawn path is not wired (no Telegram), the legacy `resume-pending` remains (hub only).

## 3. Level-of-abstraction fit

Right layer. The handler already owned "how does a topic-bound reply reach the topic"; it now asks the existing Telegram respawn primitive rather than reimplementing spawning. The primitive and its guards live in `wireTelegramRouting`, so the handler gets them through a late-bound hook, the same pattern as `_drainLocalDeliver` and `_profileLegacyRespawn`.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It changes a delivery route and when an ack is sent; it adds no new gate over messages. The ack deferral is keyed on a structural fact (the thread has a bound topic) and on the router's delivery result, not on message content.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. "Is a live session holding the topic?" is an invariant read from the session registry; the respawn reuses the existing admission chain listed above (ownership, lease gate, death classification, SpawnAdmission, spawn guard).

## 5. Interactions

- **Shadowing:** the cross-machine ask (`routeViaTopicOwner`) still runs first when its gate is on; the respawn only runs on the local path. A live local session still wins and is typed into.
- **Double-fire / races:** a user message and a peer reply arriving together both want to respawn the topic. The shared `spawningTopics` guard lets one run; the hook WAITS for an in-flight spawn (bounded) and then types the reply into the live session (Dawn's point 1 — previously `spawn-in-progress` → `failure-visible`, a smaller ACT-091). The handler also routes a reply through the hook when the session is `alive` but a spawn is still in flight (tmux up, process booting), so nothing is pasted into a booting session. A spawn that outlives the bound → `failure-visible`.
- **Router per-thread spawn guard:** `ThreadlineRouter.pendingSpawns` refused a second message on the same thread while the first was still in `handleInboundMessage`. With the respawn now awaited, that window became the whole respawn, so a second topic-bound reply was refused with `Spawn already in progress for this thread` — reaching no session and no topic (found while writing Dawn's two-replies test). A topic-linked thread now bypasses that guard (the handler/hook serializes on the topic's own spawn guard) and takes it only when it falls through to the thread-worker path. Pinned by two router unit tests.
- **Live inject inside the hook** is reported as `live-inject`, so the router/relay log never says "Resumed" for a paste (Dawn's point 3).
- **Ownership / lease / admission:** the hook refuses when the ownership record names another machine, when the G3 lease gate says forward, or when SpawnAdmission refuses (an admission error fails open, as on the Telegram path). Each refusal → `failure-visible`.
- **Death cause:** after a quota death it does not respawn (refusal → surfaced); after a context-exhausted death it drops the resume UUID and starts fresh, as the Telegram path does.
- **Stale names:** only the session the topic registry names is respawned (killed-by-name); with no registered session the cold-spawn path is used, never the thread record's `originSessionName`.
- **Possible double delivery (minor):** if the initial injection throws after the pending-inject record was written, the reply is surfaced in the topic and the boot sweep may also inject it later — a duplicate, never a loss.
- **Durability:** `awaitInitialInjection` goes through `PendingInjectStore`, so a server restart mid-respawn is recovered by the existing boot sweep.
- **Feedback loops:** a respawn makes the session alive, so the next reply injects; no repeated respawn per message. Bounded by the dead-session event itself.
- **Commitments:** `respawn-inject` resolves a report-back commitment like `live-inject` (the woken session relays to the user).

## 6. External surfaces

- Peers: ack timing changes for topic-bound replies (sent after routing, possibly tens of seconds later while a session starts) or no ack when undelivered.
- The woken session receives the reply as its bootstrap message through the Telegram spawn path (`[telegram:N]` framing), so it answers in the topic as with any respawn.
- Logs: new honest lines (`accepted but not delivered to a live session`, `Auto-ack withheld`, `Respawned topic N session`); "Resumed session" now appears only for a real resume.
- No operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN with the Telegram path's guards: the respawn happens on the machine receiving the relay message, and only when the ownership record, the G3 lease gate and SpawnAdmission all allow a local spawn. When the cross-machine reply gate is on, the existing owner ask runs before this path. No durable state added; no URLs; the only user-facing notice is the existing topic surface on refusal.

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state or migration; the CLAUDE.md card is additive text. During rollback the old loss returns.

---

## Conclusion

Restores the intended behaviour: a reply into a reaped topic wakes it through the existing respawn path, the router reports what really happened, and the "composing response" ack is only sent after a live session has the message. Every ACT-091 test fails with the `src/` change reverted.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read-only, same worktree)
**Independent read of the artifact: concern → resolved**

Raised: (1) the hook skipped SpawnAdmission and the G3 lease gate; (2) it ignored the death cause (quota / context-exhausted); (3) §4b/§7 overstated the reuse; (4) a possible duplicate delivery via the pending-inject sweep; (5) a stale `originSessionName` could be killed by name. Resolved: the hook now runs `g3ShouldSpawnLocally`, `classifySessionDeath` (no respawn after quota death, fresh start after context exhaustion) and `_spawnAdmission.admit` with a new journal-only callsite; it respawns only the registry's session and cold-spawns otherwise; §4b/§5/§7 corrected and the duplicate case documented. The e2e wiring test pins each check. Router `delivered`/`resumed`, the at-most-once deferred ack and awaiting the respawn in the relay handler were checked and found fine.

**Reviewer (PR #2174):** Dawn (JKHeadley account), read against 77e9c2d3.
**Independent read: concern → resolved**

Raised: (1) a second reply during the respawn was surfaced in the topic but never reached the session (`spawn-in-progress` → `failure-visible`); (2) a topic-bound reply the warrants gate suppresses got no ack, so the sender's health read would show a stuck channel; (3) a live inject made by the hook was reported as a respawn; (4) whether a delayed ack can trip peer-side redelivery. Resolved: the decision moved into `createThreadlineTopicRespawn`, which waits for an in-flight spawn (`SpawningTopicsRegistry.waitUntilClear`, 150 s bound) and then types the reply into the live session once; the handler consults `isTopicSpawning` so a booting-but-alive session is never pasted into directly; the suppress exit sends the non-promising `NO_REPLY_ACK_MESSAGE`; the hook reports `live-inject` for a paste. (4) answered on the PR: redelivery (`A2ARedeliverySentinel`) is off by default and keys on a 6 h TTL since last attempt, far above the ≤2.5 min respawn bound; a redelivered copy would arrive labelled by the inbound-id ledger, not as a blind duplicate.

---

## Evidence pointers

- `npx vitest run` on the ACT-091 unit, integration and e2e files plus the existing TopicLinkageHandler, remote-reply, router ledger-path, inbound-id ledger, cross-machine route, ack-never-acked and migrator parity suites — all pass; `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (routing/ack bug in server source).

`defectClass: unbounded-self-action`, `closure: n/a` — the respawn is a one-shot, inbound-driven action: ONE peer message produces at most ONE spawn attempt (behind the per-topic `spawningTopics` guard and the admission chain), never a self-retrigger. The only waiting it does is a bounded (150 s) wait on a spawn that is ALREADY in flight for the topic, after which it either types the reply into the live session once or surfaces it; nothing in this change restarts, retries, re-drives or kills on its own. The convergence argument is therefore trivial: the action count is bounded by the inbound message count, and each attempt settles in ≤ the spawn ready-timeout + confirm window.
