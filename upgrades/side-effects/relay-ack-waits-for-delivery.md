# Side-Effects Review — the relay ack waits for delivery on every path (ACT-091 follow-up)

**Version / slug:** `relay-ack-waits-for-delivery`
**Date:** `2026-10-12`
**Author:** `Echo (builder)`
**Second-pass reviewer:** `independent general-purpose reviewer subagent`

## Summary of the change

PR #2174 made the relay's automatic ack ("Message received. Composing response...") wait for the routing outcome, but only for a reply on a topic-bound thread. For every other inbound message (for example the first message on a new thread) the ack still went out before routing, so a hand-off that lost the message left the peer with a promise of a reply and then nothing. A peer saw this three times on a non-topic-bound thread.

Now the relay handler defers its own ack for every inbound message and settles it once, at the exit it actually takes.

The same handler also had a real message loss, fixed here too. `ListenerSessionManager` reported `listening` from its constructor, so `shouldUseListener` sent short messages from trusted and autonomous senders on non-topic threads to `writeToInbox`, which appends to `state/listener-inbox-<rotation>.jsonl`. Nothing in the product starts a listener session or reads that file, so the first ten such messages per server run were written and never consumed. The manager now takes the listener path only when a reader has proven itself alive with a fresh heartbeat; with none (every install today) the message falls through to the router, which spawns or resumes a session.

A live false negative in that verdict, caught the same day, is fixed too. `TopicLinkageHandler`'s live inject used `SessionManager.injectPasteNotificationConfirmed`, which returns false when the injected marker is still at the prompt after 7.5 s. A BUSY (mid-turn) Claude Code session holds the text as queued input at the prompt and reads it at the next tool round, so a live session that did receive the reply (22:21:27Z, nine seconds after the inject) was logged "failure-visible (no live session received it)" and the ack withheld. The confirmation now has a third, PROVISIONAL verdict, `queued-busy` (marker at the prompt AND the mid-turn footer, via the existing `paneShowsClaudeWorking`), which is never reported as delivered: a bounded non-blocking watch re-captures the pane until the text has left the prompt (delivered, one late ack) or provably has not (stuck at an idle prompt twice, session gone, or the 10-minute ceiling → failure-visible, no ack).

Files: `src/core/SessionManager.ts` (`injectPasteNotificationObserved`, `watchQueuedInjection`, `QUEUED_INJECTION_WATCH_CEILING_MS`; the boolean `injectPasteNotificationConfirmed` is now a wrapper that is true only for `submitted`), `src/threadline/TopicLinkageHandler.ts` (`LiveInjectOutcome`, `live-inject-pending`, the deferred `finishRouted`), `src/threadline/topicRespawnHook.ts` (the pending result variant), `src/threadline/ThreadlineRouter.ts` (`deliveryPending`), `src/threadline/autoAck.ts` (new `createRelayAckSettler`, `RelayRoutingOutcome`, `relayOutcomeDelivered`; `settleDeferredRelayAck` unchanged), `src/threadline/ListenerSessionManager.ts` (initial state `starting`, `markReaderAlive`, `hasLiveReader`, `readerHeartbeatMaxAgeMs`, `shouldUseListener` requires a live reader, `getState` adds `readerLive` / `lastReaderHeartbeatAt`), `src/commands/server.ts` (`deferSend: true`, one `relayAck.settle(...)` at each of the four routed exits, honest log lines), `src/server/routes.ts` (the not-configured listener placeholder gains the two new fields), `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` (awareness card "A2A ack waits for a live session" + shadow marker), `docs/specs/a2a-ack-never-acked.md` (Design §6), `tests/helpers/relayAckNode.ts` (the shared test composition mirrors the new order).

## Decision-point inventory

- Relay auto-ack send — modify — deferred for every inbound message (was: topic-bound replies only) and settled with the routing outcome.
- Pipe exit — add — settles `pipe-spawned` → the promising ack.
- Listener routing decision (`ListenerSessionManager.shouldUseListener`) — modify — false unless a reader heartbeat is fresh (60 s default); the trust, size, state and overflow rules are unchanged. With no reader the message goes to the router.
- Listener-inbox exit — add — settles `listener-delivered` (reader still live after the write → the promising ack) or `listener-queued` (heartbeat went stale in between → no ack).
- Router exit — modify — settles unconditionally from `result.delivered === true` (was: only when the ack had been deferred).
- Warrants-gate suppress exit (no-reply verdict or exhausted loop budget) — modify — sends the non-promising `Message received.` for every thread (was: topic-bound only; other threads had already received the promising ack before the gate ran).
- Inbound-ack exit — pass-through — the stage still consumes it; nothing is settled, an ack is never acked.
- Paste confirmation (`injectPasteNotificationObserved`) — modify — three verdicts; `queued-busy` is provisional and settles late through a bounded watch. The decision "is this pane mid-turn?" reuses `paneShowsClaudeWorking`, the indicator `verifyInjection` already trusts to NOT fire a recovery Enter; no new string list.
- Topic route on `queued-busy` — add — `live-inject-pending`: no commitment delivery, no surface, no ack until the watch settles; then `live-inject` or `failure-visible` exactly as the immediate verdicts.
- Relay handler on `deliveryPending` — add — the ack is settled from the late verdict through the same one-shot settler; never from the provisional `delivered: false`.
- Ack policy (trust, type, config, rate limit) — pass-through — the same four conditions, now evaluated at settle time.

---

## 1. Over-block

No message is blocked or delayed. One class is rerouted: a short message from a trusted or autonomous sender on a non-topic thread now goes to the router (a spawned or resumed session) instead of the listener inbox, because no reader is proven. That is the fix, not a cost: the inbox had no reader. A deployment that runs its own out-of-tree reader of that file would stop receiving messages there until it calls `markReaderAlive`; no such reader exists in this repository, and the file's only documented consumer is the session `buildBootstrapPrompt` describes, which nothing starts.

Two cases that used to get the promising ack now get something else, on purpose:

- A message whose spawn was refused or queued gets no ack. This includes the case a peer actually hit in production: a cold spawn refused with "Session limit reached (5/5)" and queued by `SpawnRequestManager`. `queued: true` is reported only when the queue admitted the payload (it refuses when globally full or when a held backlog is at its cap); either way it is `router-undelivered`. No "received, queued" receipt is sent: the queue is in memory, bounded, expires entries after 10 minutes and can evict older ones, and a new untyped text would be routed to a session by a peer from before the `ack` wire type. The log names the case as queued; if the queued message later reaches a session, that session's reply acknowledges it.
- A message the warrants gate suppresses gets `Message received.` and not `Composing response...`.

## 2. Under-block

- A `queued-busy` verdict is settled only by observation. The watch fires no recovery Enter when it finds the text stuck at an idle prompt after the turn; it resolves `stuck`, the reply is surfaced in the topic, and the text stays at the prompt until the user's next input (the same as a `stuck` verdict inside the window today, where `verifyInjection`'s own recovery has already run).
- The watch keys on Claude Code's footer. A Codex session mid-turn shows no such footer and holds the draft rather than queuing it, so a paste into a busy Codex session still reads `stuck` (unchanged; Codex drafts are the `StuckInputSentinel`'s marker path).
- The cross-machine topic-reply inject (`a2a-topic-reply-inject`) keeps the boolean confirmation: its mesh RPC cannot hold for a turn to end, so a busy owner session still reads as undelivered there. A known, narrowed false negative, not widened here.
- The `queued-busy` → `submitted` settlement proves the text left the prompt, not that the session acted on it (same strength as every other live hand-off).
- An ack is still a statement about hand-off, not about the session reading or answering the message. A session that receives the message and then dies still leaves an acked message with no reply. For a pipe session the hand-off proof is that the session passed its 2 s start check with the message as its prompt, not that the CLI accepted it.
- A handler that throws between the ack stage and an exit sends no ack. That is the honest result, and the ledger ticket's own `finally` still records the attempt.
- The same-machine HTTP routes (`/messages/relay-agent`, `/threadline/messages/receive`) send no ack and are not changed.
- A heartbeat proves a reader for 60 s; a reader that dies right after a heartbeat can still be handed one message inside that window, with the promising ack. The bound is configurable and is the cost of any liveness proof.
- Entries already sitting unread in an old listener inbox file from before this change are not recovered. The file is per server run (a new rotation id each start), so nothing reads the old ones; their senders' rows already show them unanswered.

## 3. Level-of-abstraction fit

The rule lives where the ack already lives (`autoAck.ts`), next to `settleDeferredRelayAck`, which it reuses. The handler names an outcome at each exit; the mapping from outcome to "ack / short ack / nothing" is one function, unit-tested, with a one-shot guard. A source-pinned test cuts the real handler at every `return;` and requires exactly one settle per routed exit, so a new exit added later without a settle fails the build.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It changes when our own receipt is sent and which of two fixed sentences it carries. The inputs are structural facts the handler already has (which branch ran, `spawned`, `delivered`, `suppress`); no message text is interpreted.

## 4b. Judgment-point check

No new heuristic. "Did a live consumer get it?" is read from the pipe spawner's and the router's own results. Whether a listener reader is live is not guessed from the manager's `state` label: it is a recorded heartbeat with a freshness bound, false until something records one.

## 5. Interactions

- **Ceiling.** A `queued-busy` watch gives up as `ceiling` after 10 minutes (`QUEUED_INJECTION_WATCH_CEILING_MS`): the Bash tool's maximum foreground timeout, the longest one tool call can hold a turn before Claude Code reads its queued input. A turn can run longer than one tool call, so a reply typed into a very long turn can hit the ceiling and be surfaced in the topic while the session later reads it too — a possible duplicate (reply in the topic AND in the session), never a loss, and never a promising ack without proof. Polls are 5 s apart for the first minute, then 15 s (48 pane captures per watch at most).
- **Stuck debounce.** Between a turn ending and the queued text submitting there can be one frame with an idle prompt and the marker still present; the watch requires two consecutive idle+marker polls (10 s) before resolving `stuck`, so that frame cannot produce a false `stuck` + surface.
- **Lazy watch.** The watch starts only when a caller calls `settle()`; the boolean wrapper never starts it, so the mesh inject path does not leave 10-minute pollers behind.
- **Ledger.** The ticket is finished when the handler returns, so a `deliveryPending` message is recorded as `handoff-failed` (not a hand-off) at that moment; a resend from the peer during the watch is delivered rather than dropped by id. Honest in the conservative direction.
- **Commitment.** On `live-inject-pending` the commitment is neither delivered nor marked reply-arrived until the watch settles; the deferred `finishRouted` then runs exactly as the immediate one would.
- **Rate limiter.** `isAckRateLimited` counts on every call. It used to be called before routing for every non-topic message; it is now called only when an ack is due, so undelivered messages no longer use up the per-sender budget (integration test: five undelivered, the sixth delivered is still acked).
- **Double ack.** The settler is one-shot; a path that settled and fell through cannot send again. The stage sends nothing when deferred, and a non-deferred input makes `settle` a no-op (`not-deferred`).
- **Sender-side tracker.** No ack leaves the peer's row `awaiting-ack`, later `stale`/dark — accurate for a message no live session holds. `A2ARedeliverySentinel` (off by default, 6 h TTL) is far above any spawn time.
- **Ack-loop invariant.** Unchanged: an inbound ack returns before the settler is ever used; `NO_REPLY_ACK_MESSAGE` goes out with the `ack` wire type, and older peers' prefix test covers it.
- **Loop-budget exit.** Each suppressed message in a loop gets one short ack, bounded by the same rate limiter (5 per 60 s per sender); before this change each got the promising ack under the same limiter.
- **Listener hand-off (fixed here).** With no proven reader the handler's listener branch is never entered, so `writeToInbox` and `recordHandoff('listener')` do not run and the router's own ledger outcome is recorded.
- **Rapid-fire pipe guard.** A second message on a thread with an active pipe session used to fall through to the listener inbox "to queue serially" (where, with no reader, it was lost). It now falls through to the router, which does not know about pipe sessions (they are tracked only in `PipeSessionSpawner`, never in `threadResumeMap`), so it cold-spawns a second session for the same thread. Nothing is killed (different tmux names), but two sessions may both answer on that thread, and the new one will not see the pipe session's reply in progress. This is what already happened for every sender below `trusted`; for trusted senders it replaces a lost message with a possible duplicate answer. The handler comment now says so.
- **Threadless messages.** The old listener path gave a trusted sender's threadless messages one stable synthetic thread id; the router now gives each its own thread and session, as it already did for senders below `trusted`.
- **Other users of the manager.** Checked: `shouldUseListener` and `writeToInbox` have one caller each (the relay handler). `listenerManagerForResume` / `ThreadlineReapRecovery` and the reply routes use only the canonical inbox/outbox files and the reply-claim maps, which never read `state`. `getQueueDepth` reads the inbox and ack files only. `/threadline/status` passes `getState()` through; no code or dashboard reads its `active` or `state` field. `InboundIdLedger`'s `listener` outcome is unchanged.
- **Ledger on a queued refusal.** Unchanged: `outcomeFromRouterResult` gives `handoff-failed` for `queued: true`, so a resend is delivered rather than dropped by id while the original waits in the volatile queue. The log line, not the ledger, names it as queued.
- **Session load (Dawn's review note).** Messages that used to vanish into the inbox now ask for a session through `SpawnRequestManager`, under its existing limits, cooldowns and queue. That is new real work for trusted peers' short messages, so a machine near its session cap reaches "Session limit reached" sooner (Scout sat at 5/5 with a session wedged since Oct 9 when this happened). What covers that is the capacity-refusal queue, and its limits are the honest part: it is in memory (a server restart drops it), entries expire after 10 minutes, it is bounded per agent (default 1 while degraded) and globally, and a later arrival can evict an older entry. A message in that queue gets no ack, so the sender sees it as unacknowledged; if it expires before a slot frees, the sender's record stays unacknowledged and a resend is delivered. Reaping wedged background sessions (what actually filled Scout's slots) is a separate follow-up, not this PR.

## 6. External surfaces

- Peers: the ack arrives after routing (for a cold spawn, after the spawn was admitted and started; for a pipe session, after the intent classifier call and the 2 s start check) or not at all when nothing live has the message. Suppressed messages get the short ack.
- `/threadline/status` → `listener` gains `readerLive` and `lastReaderHeartbeatAt`; `state` starts as `starting` and `active` is false until a reader is proven.
- Peers: a reply typed into a busy session gets its ack later than before — when the text has actually left the prompt, up to the 10-minute ceiling — instead of no ack at all (the false negative). The commitment and topic surface move with it.
- Logs: `live-inject-pending (queued in a busy session; confirming)`, `pending inject settled <submitted|stuck|ceiling|session-gone>`, `Delivery to … pending — queued in a busy live session`, `Queued reply … left the prompt (submitted) — delivered, ack sent` and `Auto-ack withheld … queued text never left the prompt (<case>)` are new; `Auto-ack withheld … queued in the listener inbox; no live listener is proven` is new (only when a heartbeat goes stale mid-hand-off); `Auto-ack withheld … no live session received the message` now appears for any thread.
- CLAUDE.md: one new awareness card for new and existing agents.
- No route, config key, stored format or operator action.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN: the ack is sent by the machine that holds the relay connection and ran the handler, about a hand-off made on that machine. No state is added. A standby does not connect to the relay and never runs the handler. No user-facing notice, no URL.

## 8. Rollback cost

Pure code change — revert and ship a patch. Reverting restores the listener loss as well as the early ack. No persistent state, no migration to undo; the CLAUDE.md card is additive text that would then describe behaviour that is gone, and would need a follow-up wording change. During rollback the false promise returns.

---

## Conclusion

The promising ack now means one thing on every path: a live consumer has the message. Messages are no longer written to a listener inbox nothing reads; they go to a session. A reply typed into a busy session is no longer misread as lost: nothing is promised until the text has left the prompt, and then exactly one ack goes out. The honest cost is that a refused or queued spawn no longer gets an ack, and a reply into a very long turn may wait up to ten minutes for its ack.

---

## Second-pass review (if required)

**Reviewer (round 1, the deferred ack):** independent general-purpose reviewer subagent (read-only, same worktree)
**Independent read of the artifact: concur**

Checked and found fine: every exit of the handler after the ack stage settles exactly once with the right outcome; the settler is one-shot; every `ThreadlineRouter.handleInboundMessage` return sets `delivered` truthfully, so no live hand-off loses its ack; nothing on the sender side depends on a fast ack (stale threshold and redelivery TTL are both 6 h); nothing in `src/`, scripts, skills or templates reads the per-rotation listener inbox file. Notes taken in: the pipe ack proves the pipe session passed its 2 s start check, not that the CLI accepted the prompt (§2); the pipe ack now follows the intent-classifier call and that check (§6).

**Reviewer (round 2, the listener loss):** independent general-purpose reviewer subagent (read-only, same worktree)
**Independent read of the artifact: concern → resolved**

Confirmed: `shouldUseListener` and `writeToInbox` each have one production caller; nothing reads the per-rotation inbox file; nothing outside tests calls `rotate()`/`needsRotation()`; reply-claim and canonical-inbox methods never read `state`; nothing reads `/threadline/status` `.listener`; heartbeat edge cases are safe (a future timestamp reads as no reader; `mergeDefaults` keeps the 60 s default); the promising ack for `listener-delivered` is defensible. Raised (should-fix, documentation): the §5 claim that the router's spawn guard serializes a message on a thread with a live pipe session was overstated — the router does not know about pipe sessions and cold-spawns a second session. Resolved: §5 rewritten to say that plainly (nothing is killed; two sessions may both answer; this is what already happened below `trusted`), the stale handler comment corrected, and the threadless-message change noted. Also noted: `rotate()` does not reset the heartbeat (harmless; nothing calls either).

**Reviewer (round 3, the busy-session false negative):** Dawn (JKHeadley account) on the PR, and the coordinator from a live log on this machine. Raised: a wrong `delivered: false` now withholds the ack on every path, and the live case showed one; then, on the first proposed fix, that treating "marker at the prompt + mid-turn footer" as delivered outright would turn a stale footer into a false positive. Resolved as the provisional `queued-busy` verdict, the bounded watch, the ceiling-as-undelivered rule, and one `delivered === true` test per delivering route.

**Not independently reviewed:** the queued-refusal addition made after round 2 (`describeUndeliveredRouterResult`, its log line, the spec and artifact text on why no "queued" receipt is sent). It changes a log string and documentation only; the ack outcome for a queued result was already `router-undelivered` and was covered by both rounds.

---

## Evidence pointers

- `npx vitest run tests/unit/threadline/autoAck.test.ts tests/unit/threadline/ack-stage-wiring.test.ts`, `tests/unit/ListenerSessionManager.test.ts`, the integration files `relay-ack-waits-for-delivery`, `ack-never-acked` and `threadline-responsive-messaging`, the e2e `ack-never-acked-alive`, the migrator parity and feature-delivery tests — all pass; `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (ack timing bug in server source).

`defectClass: unbounded-self-action`, `closure: n/a` — the change removes sends and adds none: one inbound message produces at most one ack (one-shot settler), bounded per sender by the existing rate limiter. Nothing here retries, re-drives, spawns or kills.
