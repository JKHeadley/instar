# Side-Effects Review — the relay ack waits for delivery on every path (ACT-091 follow-up)

**Version / slug:** `relay-ack-waits-for-delivery`
**Date:** `2026-10-12`
**Author:** `Echo (builder)`
**Second-pass reviewer:** `independent general-purpose reviewer subagent`

## Summary of the change

PR #2174 made the relay's automatic ack ("Message received. Composing response...") wait for the routing outcome, but only for a reply on a topic-bound thread. For every other inbound message (for example the first message on a new thread) the ack still went out before routing, so a hand-off that lost the message left the peer with a promise of a reply and then nothing. A peer saw this three times on a non-topic-bound thread.

Now the relay handler defers its own ack for every inbound message and settles it once, at the exit it actually takes. Files: `src/threadline/autoAck.ts` (new `createRelayAckSettler`, `RelayRoutingOutcome`, `relayOutcomeDelivered`; `settleDeferredRelayAck` unchanged), `src/commands/server.ts` (`deferSend: true`, one `relayAck.settle(...)` at each of the four routed exits, honest log lines), `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` (awareness card "A2A ack waits for a live session" + shadow marker), `docs/specs/a2a-ack-never-acked.md` (Design §6), `tests/helpers/relayAckNode.ts` (the shared test composition mirrors the new order).

## Decision-point inventory

- Relay auto-ack send — modify — deferred for every inbound message (was: topic-bound replies only) and settled with the routing outcome.
- Pipe exit — add — settles `pipe-spawned` → the promising ack.
- Listener-inbox exit — add — settles `listener-queued` → no ack.
- Router exit — modify — settles unconditionally from `result.delivered === true` (was: only when the ack had been deferred).
- Warrants-gate suppress exit (no-reply verdict or exhausted loop budget) — modify — sends the non-promising `Message received.` for every thread (was: topic-bound only; other threads had already received the promising ack before the gate ran).
- Inbound-ack exit — pass-through — the stage still consumes it; nothing is settled, an ack is never acked.
- Ack policy (trust, type, config, rate limit) — pass-through — the same four conditions, now evaluated at settle time.

---

## 1. Over-block

No message is blocked, delayed or rerouted; only our own ack changes. Three cases that used to get the promising ack now get something else, each on purpose:

- A message written to the warm-listener inbox gets no ack. `ListenerSessionManager.writeToInbox` appends to a file and succeeds whether or not anything reads it; the manager reports `listening` from its constructor, nothing in `src/` calls `setState`, starts a listener session or reads the per-rotation inbox file. A deployment that does run its own reader loses the early ack only: that reader's reply is the sender's acknowledgement (a reply on the thread already counts as one).
- A message whose spawn was refused or queued gets no ack. If a queued spawn later runs and answers, the answer acknowledges it.
- A message the warrants gate suppresses gets `Message received.` and not `Composing response...`.

## 2. Under-block

- An ack is still a statement about hand-off, not about the session reading or answering the message. A session that receives the message and then dies still leaves an acked message with no reply. For a pipe session the hand-off proof is that the session passed its 2 s start check with the message as its prompt, not that the CLI accepted it.
- A handler that throws between the ack stage and an exit sends no ack. That is the honest result, and the ledger ticket's own `finally` still records the attempt.
- The same-machine HTTP routes (`/messages/relay-agent`, `/threadline/messages/receive`) send no ack and are not changed.
- The listener hand-off itself is not fixed here (see §5 and the PR's finding); only what we tell the peer about it is.

## 3. Level-of-abstraction fit

The rule lives where the ack already lives (`autoAck.ts`), next to `settleDeferredRelayAck`, which it reuses. The handler names an outcome at each exit; the mapping from outcome to "ack / short ack / nothing" is one function, unit-tested, with a one-shot guard. A source-pinned test cuts the real handler at every `return;` and requires exactly one settle per routed exit, so a new exit added later without a settle fails the build.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It changes when our own receipt is sent and which of two fixed sentences it carries. The inputs are structural facts the handler already has (which branch ran, `spawned`, `delivered`, `suppress`); no message text is interpreted.

## 4b. Judgment-point check

No new heuristic. "Did a live consumer get it?" is read from the pipe spawner's and the router's own results. The one classification made here — the listener inbox is a queue, not a consumer — is a fixed property of that code path, documented at the type and at the call site.

## 5. Interactions

- **Rate limiter.** `isAckRateLimited` counts on every call. It used to be called before routing for every non-topic message; it is now called only when an ack is due, so undelivered messages no longer use up the per-sender budget (integration test: five undelivered, the sixth delivered is still acked).
- **Double ack.** The settler is one-shot; a path that settled and fell through cannot send again. The stage sends nothing when deferred, and a non-deferred input makes `settle` a no-op (`not-deferred`).
- **Sender-side tracker.** No ack leaves the peer's row `awaiting-ack`, later `stale`/dark — accurate for a message no live session holds. `A2ARedeliverySentinel` (off by default, 6 h TTL) is far above any spawn time.
- **Ack-loop invariant.** Unchanged: an inbound ack returns before the settler is ever used; `NO_REPLY_ACK_MESSAGE` goes out with the `ack` wire type, and older peers' prefix test covers it.
- **Loop-budget exit.** Each suppressed message in a loop gets one short ack, bounded by the same rate limiter (5 per 60 s per sender); before this change each got the promising ack under the same limiter.
- **Listener hand-off (not changed, reported).** By code reading the inbox file has no reader in this repository, and `shouldUseListener` keeps choosing it for trusted senders with short messages until ten unread entries pile up. That is a possible message loss in its own right and is reported in the PR for a separate fix; this change does not widen to it. Until it is fixed, a trusted peer whose short messages take that path will see them as unacknowledged — accurate, and more visible than before.

## 6. External surfaces

- Peers: the ack arrives after routing (for a cold spawn, after the spawn was admitted and started; for a pipe session, after the intent classifier call and the 2 s start check) or not at all when nothing live has the message. Suppressed messages get the short ack.
- Logs: `Auto-ack withheld … queued in the listener inbox; no live listener is proven` is new; `Auto-ack withheld … no live session received the message` now appears for any thread.
- CLAUDE.md: one new awareness card for new and existing agents.
- No route, config key, stored format or operator action.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN: the ack is sent by the machine that holds the relay connection and ran the handler, about a hand-off made on that machine. No state is added. A standby does not connect to the relay and never runs the handler. No user-facing notice, no URL.

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state, no migration to undo; the CLAUDE.md card is additive text that would then describe behaviour that is gone, and would need a follow-up wording change. During rollback the false promise returns.

---

## Conclusion

The promising ack now means one thing on every path: a live session has the message. The honest cost is that two hand-offs that cannot prove a live consumer (the listener inbox, a refused or queued spawn) no longer get an ack.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read-only, same worktree)
**Independent read of the artifact: concur**

Checked and found fine: every exit of the handler after the ack stage settles exactly once with the right outcome (the inbound-ack exit settles nothing; gate and pipe errors fall through to a later exit; a throw sends no ack); the settler is one-shot; every `ThreadlineRouter.handleInboundMessage` return sets `delivered` truthfully, so no live hand-off loses its ack; nothing on the sender side depends on a fast ack (stale threshold and redelivery TTL are both 6 h). The reviewer confirmed by search that nothing in `src/`, scripts, skills or templates reads the per-rotation listener inbox file, calls `setState` or `buildBootstrapPrompt`, or starts a listener session. Notes taken into this artifact: the pipe ack proves the pipe session survived its 2 s start check, not that the CLI accepted the prompt (§2); the pipe ack now follows the intent classifier call and that start check (§6); trusted peers whose short messages go to the unread listener inbox will now, accurately, show as unacknowledged, which makes the separate listener fix more urgent (§5).

---

## Evidence pointers

- `npx vitest run tests/unit/threadline/autoAck.test.ts tests/unit/threadline/ack-stage-wiring.test.ts`, the integration files `relay-ack-waits-for-delivery` and `ack-never-acked`, the e2e `ack-never-acked-alive`, the migrator parity and feature-delivery tests — all pass; `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (ack timing bug in server source).

`defectClass: unbounded-self-action`, `closure: n/a` — the change removes sends and adds none: one inbound message produces at most one ack (one-shot settler), bounded per sender by the existing rate limiter. Nothing here retries, re-drives, spawns or kills.
