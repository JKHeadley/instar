# Side-Effects Review — the session watcher skips topics another machine owns

**Version / slug:** `session-monitor-peer-owned-topic`
**Date:** `2026-10-25`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** independent reviewer subagent (session lifecycle: the change removes a recovery/triage trigger on peer-owned topics). See the appended review.
**Tier:** `1` — one optional dep, one skip in `poll()`, one wiring closure; ~34 source lines. A revert fully undoes it; no persistent state, no new surface.
**Effort:** 0 spec rounds, 1 commit attempt. Proportionate.

## Summary of the change

`SessionMonitor` polls every topic in the local Telegram topic→session map. A non-owner machine can keep a stale entry after the topic moves to another pool machine. For such a topic the local session is "dead" only because the conversation runs elsewhere; with an unanswered user message (the poller records every inbound locally) the monitor ran mechanical recovery, then triage, then posted "The session has stopped. Send a new message to start a fresh session with full conversation context." — telling the operator to resend a message the owner was already answering.

Incident (2026-10-25, topic 128732 "Feature maturation"): Studio 17:49:20 `route topic 128732 → action=forwarded owner=m_e8c9… (Mama PC) acked=true`; Mama PC 17:49:22 `owner-side resume for forwarded topic 128732`, 17:49:28 `Injected initial message`; Studio notice at 17:49:24.883. Identical notice in the same topic 2026-10-23 22:01:01, 26 s after the operator's message.

Fix: new optional dep `isTopicOwnedByPeer(topicId)`; `poll()` skips such a topic and drops its snapshot. Wired in `server.ts` to the ownership registry with a predicate narrower than "the record names a peer": pool stage not `dark`, registry + self id present, record status `active`, owner not self, AND the owner online per `isOwnerReachableShared` (the same helper the Part-D recovery gates use). Placing/transferring records and a dark owner therefore keep today's monitoring. A throwing lookup (unreadable registry, or a poll before the late-bound registry is assigned) → monitor as today.

## Decision-point inventory

- `SessionMonitor.poll()` — **modify**: an additional skip condition before `checkSession`. It only removes actions (notice, triage, mechanical recovery) for topics this machine does not own; it adds no blocking authority anywhere else.

## 1. Over-block

A topic this machine really serves while an ONLINE peer holds an `active` record for it would lose its watcher. `route()` forwards to such an owner in the normal case; the second-pass review named the fall-throughs where it still dispatches locally under a peer-named record (owner lacks the forward capability and the durable queue refuses; a `placing`/`transferring` record with an un-acked queue; a dead owner during failover re-placement; a `route()` throw with no queue row). The predicate was tightened to `active` + online owner, which removes the placing/transferring and dead-owner cases. Accepted residual: the owner-lacks-forward-capability and route-throw fall-throughs can leave a local session unwatched while the record names an online active peer; the next inbound still reaches the respawn-on-dead path, and the leftover session is converged by the reaper/reconciler.

## 2. Under-block

- Pool stage `dark` with multiple machines: no routing happens, so this machine dispatches locally and is the right one to watch. Unchanged.
- The owner machine itself still sends the same "send a new message" wording when its own session dies and triage cannot resolve it. That wording conflicts with "one message must be enough"; on the owner the inbound path respawns a dead mapped session when the message arrives, so the notice there only fires when that respawn failed. Not changed here; filed as feedback (see Conclusion).
- The Mama PC's first session failed its turns at once (Claude Code binary too old for the pinned model, API 400). Already remediated on the machine (updated to 2.1.310 and refreshed at 18:00 UTC). Separate class; filed as feedback.

## 3. Level-of-abstraction fit

Right layer: the monitor already takes per-topic deps; the ownership decision is read from the same registry and reachability helper `route()` and the Part-D recovery gates use. They apply different predicates (route() also checks the queue ack), so they are not identical — see §1 for the residual. `SessionRecovery`'s Part-D gate is flag-gated (`ownershipFollowsLiveWork`) and only covers its own sub-paths, not triage or the notice, so it could not carry this.

## 4. Signal vs authority compliance

Compliant. The change removes an action (a user-facing notice and a local triage respawn) on a deterministic ownership record; it holds no new blocking authority over messages or sessions. Ref `docs/signal-vs-authority.md`.

## 5. Interactions

- Stuck-message recovery and `SessionRecovery` Part D already skip peer-owned topics; this aligns the third per-topic path.
- Owner-dark ladder handles a dark owner's notices. With the tightened predicate a dark owner means the monitor keeps watching any local session (today's behavior); when inbound was dispatched locally as a fall-through, that session keeps its recovery.
- Snapshot deletion on skip means a later return of ownership starts a fresh snapshot (a first poll records state, the next acts) — same as a newly mapped topic.

## 6. External surfaces

User-visible: one false Telegram notice no longer sent from non-owner machines. No API, config or file-format change.

## 7. Multi-machine posture

This IS the multi-machine fix: the monitor is machine-local by design and now defers to the pool ownership record (the one-voice rule for user-facing notices). Single-machine: `_meshSelfId`/registry absent → `false` → unchanged.

## 8. Rollback cost

Revert the commit; next release restores the previous behavior. No state to repair.

## Conclusion

Ship. Follow-ups filed as feedback (owner-side "send a new message" wording; Claude Code binary vs pinned-model instant-fail being silent).

## Second-pass review

Reviewer (independent subagent, 2026-10-25): scope/late binding of the `server.ts` closure confirmed correct; a poll before the registry is assigned throws and resolves to "monitor as today". **Concern raised:** the first cut's artifact claimed a peer-named record always means `route()` forwards; `ownerOf()` also names the peer during `placing`/`transferring`, dead-owner failover, the owner-lacks-forward-capability case and route-throw fall-throughs that dispatch locally, so a local session in those windows would lose monitor recovery.

Response: predicate tightened to record status `active` + owner online (`isOwnerReachableShared`), which closes the placing/transferring and dead-owner windows; the two remaining fall-throughs are recorded in §1 as an accepted residual (next inbound respawns; reaper/reconciler converges the leftover). §3 and §5 corrected to say the predicates differ rather than "cannot diverge".
