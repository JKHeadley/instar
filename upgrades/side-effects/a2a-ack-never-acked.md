# Side-Effects Review — an ack is never acked

**Version / slug:** `a2a-ack-never-acked`
**Date:** `2026-10-08`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

Spec: docs/specs/a2a-ack-never-acked.md (converged, 2 passes; approved under the operator's standing approval for the agent-comms track, 2026-10-06 18:57, topic 122413). Tracking: ACT-063.

## Summary of the change

The automatic "Message received. Composing response..." acknowledgement went out as an ordinary `type: 'chat'` message, so the receiving agent's relay handler acked it back (about five acks each way per message, ended only by the per-sender rate limit) and, when the ack was the first inbound on a thread the receiver itself had started, spawned a session to answer it.

- New `src/threadline/autoAck.ts`: `isAutoAckInbound` / `autoAckRecognition` (wire type `ack`, or an exact whole-message match against the one fixed ack sentence), `looksLikeAutoAckText` (the old prefix test, kept only for the reply waiter), `runRelayAckStage`, `createAckRateLimiter`, and the shared plaintext payload `encode`/`decode`.
- `src/commands/server.ts` (`handleGatePassedRelayMessage`): the ack stage runs right after the reply-waiter check. A recognised ack records delivery, writes the ledger disposition `no-reply`, and returns before the auto-ack send, the inbox append, the Telegram mirror, the warrants gate and every router. Our own ack is sent with `ThreadlineClient.sendAck` (`type: 'ack'`).
- `src/threadline/client/ThreadlineClient.ts`: `sendAck`; `sendPlaintext` unchanged on the wire.
- `src/threadline/ThreadlineBootstrap.ts`: the unknown-sender decode uses the shared `decodePlaintextPayload` (same behaviour).
- `src/threadline/WarrantsReplyGate.ts`: the pure-ack check moves above the first-contact check.
- `src/server/routes.ts` (`/messages/relay-agent`): an inbound ack records delivery and `no-reply` and returns after auth, the loop check and the ledger commit, before `messageRouter.relay` stores it, and so before the gate and the router. `src/threadline/ThreadlineEndpoints.ts` (`/threadline/messages/receive`): the same, before the router.

## Decision-point inventory

- Ack stage in the relay handler — **add** — recognised ack → record delivery, stop; anything else → send our ack (existing conditions), continue.
- Ack recognition (`isAutoAckInbound`) — **modify** — was a prefix test with one non-terminal use; now a structural test (wire type or exact sentence) that stops the message. The prefix test survives only in its old role.
- `WarrantsReplyGate.evaluate` ordering — **modify** — pure-ack before first-contact.
- Ack short-circuit on the two HTTP inbound routes — **add**.
- Per-sender ack rate limiter — **pass-through** — same limit, same window, moved into a function.

---

## 1. Over-block

- **Ack stage.** It sets aside a message only when the sender marked it `type: 'ack'`, or when the whole message is exactly `Message received. Composing response...`. A real message that opens with those words (`Message received. Deploy the fix now.`) is not matched and is handled in full; tested on the relay path and on both HTTP routes. A peer that marks real content as `type: 'ack'` loses that content — its own declaration, and nothing a peer could not already do by not sending.
- **Gate reorder.** A first inbound made only of acknowledgement words (`thanks`, `ok`, `got it, thank you`, `on it`, `will do`, `noted`, `lgtm`, an emoji-only or empty message; at most eight words, no `?`) no longer gets past the gate. A control token (`approved`, `done`, `yes`, `stop`, …), a question, an imperative, `expectsReply` and a verified human are all checked first.
  - **What a suppressed message loses is more than a reply session.** A gate suppression returns before `ThreadlineRouter.handleInboundMessage`, which is the only place `TopicLinkageHandler.tryRouteReplyToTopic` runs, and before `collaborationSurfacer.surface`. So on a thread we started from a Telegram topic, a peer's first reply that is only `lgtm` or `will do` is not shown in that topic. It is recorded on the conversation (the dashboard's Threadline tab); on the relay path it is also in the canonical inbox, and in a bridge topic only where the default-off Telegram bridge is on. `/messages/relay-agent` has neither of those two.
  - **Where this is a real change and where it is not.** Every reply after the first already behaves this way. On the relay path with a peer that auto-acks, the peer's ack used to be the first inbound, so the peer's actual first reply was already the second message and already subject to this check; now that the ack is consumed without touching the conversation, the reorder is what keeps that behaviour the same. That holds only for a relay peer whose keys we do not hold (the path on which its plaintext ack arrived at all). The outcome genuinely changes for a first reply made only of acknowledgement words in three cases: on `/messages/relay-agent` (same-machine agents, where no auto-ack is sent), from a relay peer whose keys we already hold (its plaintext ack was always discarded, so its real reply was always the first inbound), and from a peer with `autoAck` off.
  - This is the consequence of the reorder as specified. It is stated here and in the report to the operator rather than softened; no surfacing change is made in this fix.
- **A consumed ack is not written to the canonical inbox, the message store or a bridge topic.** That is the requested behaviour; the trace left is the ledger row, the delivery record and a log line naming the thread and the recognition (`by type` / `by exact-text`).

## 2. Under-block

- An older peer configured with its own `autoAckMessage` is not recognised by the stage. Its ack reaches the warrants gate; if it is not made of acknowledgement words it can still count as first contact and spawn, as today.
- Two older peers still ack each other to the rate limit (their code).
- An older peer still acks our typed ack once (its old habit); we consume that reply by its exact text, so the exchange ends at three frames instead of eleven.
- A peer that already holds our keys tries to decrypt the plaintext ack and discards it (no listener on `decrypt-error`). The ack never arrives there, before or after this change. Not addressed here.
- The warrants gate's pure-ack vocabulary misses unfamiliar wordings; those go on to first contact / novelty / the classifier as before.
- **A typed ack clears a delivery row and leaves no message text.** Delivery is matched by thread id only, and a relay-authenticated unknown sender is treated as `verified`, so any relay peer that knows a thread id can mark our oldest outstanding message on it as acknowledged. That was already possible with any message on the thread; the difference is that the message used to be visible in the inbox and now leaves only the log line (full thread id, sender prefix, recognition) and the ledger row. The trust level of unknown relay senders is a separate tracked item (ACT-066) and is not changed here.
- **Listener-daemon mode is not covered.** When the standalone daemon owns the relay connection, the server's relay handler is not wired; the daemon writes raw envelopes to the listener inbox and sends no acks. An ack from a peer lands in that inbox like any other envelope. The inbound-id ledger makes the same exclusion.

## 3. Level-of-abstraction fit

The loop was in the relay handler, so the stop is in the relay handler, ahead of every side effect. Recognition is a transport fact (a wire type on a message our own software generates), which belongs below the warrants gate: the gate judges whether content deserves a reply, and a receipt is not content. The gate reorder is a second layer at the gate's own level for hand-written acknowledgements. The stage, the limiter and the payload codec live in one small module so the tests run the code the server runs; the handler itself stays a closure in `server.ts` and its ordering is pinned by a source-order wiring test.

## 4. Signal vs authority compliance

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [x] Mixed — see below; one part is structural (outside the principle), one part is flagged.

**Ack stage: structural, not a judgment.** It tests a protocol field (`type === 'ack'`) or exact equality with one constant string our own software emits. It reads no meaning from text. This is the "hard-invariant / transport mechanics" case `docs/signal-vs-authority.md` excludes. The first draft used a prefix test with stopping authority; the Standards-Conformance Gate flagged it under this principle and it was replaced by the exact match. The prefix test keeps only its older, non-stopping role (it declines to treat such a message as the reply a waiter is waiting for).

**Gate reorder: flagged, disclosed.** The Standards-Conformance Gate reports two possible violations (*Signal vs. Authority*, *Intelligence Infers, Keywords Only Guard*) on moving the pure-ack word-list check ahead of first contact: a fixed vocabulary decides that a hand-written "thanks" needs no reply before the classifier is asked. The check is not new — it already runs ahead of novelty and the classifier for every message after the first; this change removes its one exemption, as the fix was specified. It withholds an automatic reply session (a self-action), not the message. The finding stands unresolved in `docs/specs/reports/a2a-ack-never-acked-convergence.md` for the operator's review; if the word list should stop deciding alone, that applies to the gate as a whole and is a separate change.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Ack recognition is an invariant over an enumerable domain (one wire type, one constant sentence), declared in the spec's `## Decision points touched`. The gate change reorders two existing deterministic checks; the gate's classifier — its judgment authority — is untouched and still decides the ambiguous cases.

## 5. Interactions

- **Shadowing.** The stage runs after the reply-waiter check and before everything else. For a recognised ack the inbox append, Telegram mirror, warrants gate, collaboration surfacer, pipe spawner, listener inbox and router no longer run. None of them is relied on for an ack: delivery recording, the one thing an ack is for, is done by the stage through the same `recordInboundAck` funnel (`inbound-ack-wiring.test.ts` still passes).
- **Inbound-id ledger.** The ack's row becomes `no-reply`, a terminal disposition: a relay-redelivered copy of the same ack id is dropped by the gate's ledger lookup before the rate limiter. `runRelayInboundWithLedger`'s `finally` finishes the ticket as before.
- **Delivery tracker.** Matching is by thread, oldest outstanding first (unchanged). One message now yields one ack, so one outstanding row is cleared; under the loop, up to five were cleared for one message. This makes `/threadline/peers/health` more accurate, not less.
- **Double-fire.** The ack stage and the gate's pure-ack check cannot both act: a consumed ack never reaches the gate.
- **Races.** No shared mutable state is added. The limiter keeps its per-sender map.
- **Feedback loops.** This removes one: ack → ack → ack. The reply-waiter path is unchanged (a recognised ack never resolves a waiter; asserted in the wiring test).
- **Warm sessions / `preferWarmSession`.** Unchanged for real messages; never reached for acks.

## 6. External surfaces

- **Other agents.** The auto-ack's wire `type` changes from `chat` to `ack`. A peer on current `main` or older (as far as the code could be read — history before 2026-08-14 is squashed) passes an unknown type through its unknown-sender decode and tests only `!== 'status'`, so it treats the typed ack exactly as it treated the chat ack. Covered by the mixed old/new tests.
- **Message store.** On `/messages/relay-agent` a consumed ack is no longer saved by `MessageRouter.relay` (it used to sit at phase `received` until its TTL dead-lettered it) and no longer appears in `threadline_history` for the thread.
- **HTTP responses.** `/messages/relay-agent` answers an inbound ack with `200 { ok, accepted, delivered, threadline: { handled, spawned: false, suppressed: true, signal: 'auto-ack' } }` — the same shape as an existing gate suppression. `/threadline/messages/receive` answers as before (`accepted: true, async: true`).
- **Persistent state.** No new store or column. Ledger rows for acks are `no-reply` instead of `handed-off`.
- **Logs.** One line per consumed ack: `[relay] delivery ack from <8 hex> (thread: <full id>, by type|exact-text) recorded — not acked, not routed`. No message text.
- **Telegram.** Acks are no longer mirrored into Threadline bridge topics (they were noise there).
- **Operator surface.** No operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The stage is a stateless rule applied to each inbound message on the machine that received it. A standby does not hold the relay connection and never runs the handler. The two records it writes keep their existing posture: the delivery tracker row is per machine; the ledger row is per machine and readable pool-wide through `GET /a2a/inbound-ids?scope=pool`. No user-facing notice is emitted, no durable state is added that could strand on a topic transfer, and no URL is generated.

## 8. Rollback cost

Pure code change: revert and ship a patch. No data migration; `no-reply` ledger rows written meanwhile stay valid. During the rollback window a reverted agent treats a newer peer's typed ack as any plaintext message (it acks it once; the newer peer consumes that). No flag exists, by decision: the loop is a defect in always-on behaviour and a dark flag would leave it running on the fleet.

## Conclusion

The review changed the design twice: stopping authority was taken away from the prefix test and given only to a structural match (wire type or exact sentence), and after the second-pass review the `/messages/relay-agent` ack stage moved ahead of the message store. Two things are left open and disclosed rather than argued away: the Standards-Conformance finding on the warrants-gate reorder, and the reorder's effect on topic surfacing for a first reply made only of acknowledgement words. No template or migration change is needed (no agent-facing text changes). Clear to ship as a fix.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only; read the code, ran no tests)
**Independent read of the artifact: concern — three raised, all resolved or disclosed below**

1. **The gate reorder withholds more than a reply session.** A suppressed message never reaches `handleInboundMessage`, so `TopicLinkageHandler` and `collaborationSurfacer` never see it; a peer's first reply of `lgtm` / `will do` on a topic-bound thread is not shown in the topic. The artifact's "already in the inbox and mirrored" held only on the relay path with a listener manager and the default-off bridge. → §1 rewritten to say exactly this, including where it is and is not a change from today. No code change: it is the reorder as specified, and it is reported to the operator.
2. **On `/messages/relay-agent` a consumed ack was still persisted** by `MessageRouter.relay` (shown in thread history, left at `received` until TTL dead-letter). → Fixed: the ack stage now runs before `relay()`; a wiring test pins the order and the integration test asserts the ack is absent from the message store.
3. **A typed ack clears a delivery row with no content trace** (matching is by thread id; unknown relay senders are `verified`). Mostly pre-existing. → Added to §2; the log line now carries the full thread id.

Checked and found correct by the reviewer: no send, gate, router or spawn after a recognised ack on any of the three handlers; recognition cannot set aside a prefix-only message on any body shape; `recordNoReply` is written once and `finish()` cannot overwrite it on all three paths; a typed ack with custom text cannot resolve a reply waiter; `sendPlaintext` wire bytes and the bootstrap decode are unchanged; control tokens, questions, imperatives and `expectsReply` still decide before pure-ack.

**Re-read after the fixes: concern — two statements corrected, early return confirmed correct.** (a) §1 understated where the reorder is a real change: a relay peer whose keys we hold never delivered its plaintext ack, so its first reply was always first contact — added. (b) On `/messages/relay-agent` the content-dedup window runs before the ack stage and every ack has the same text, so a second genuine ack on a thread inside the window was answered "duplicate content" and its delivery row left uncleared (this predates the change). → Fixed: a consumed ack now releases its content-window entry; repeats of the same ack are caught by id in the ledger; the integration test sends two acks on one thread and asserts both delivery rows clear. The reviewer confirmed the early return: after auth, loop check and ledger commit, before `relay()`; delivery recorded once; `no-reply` written once and the ticket finished by the route's `finally`; response shape matches a gate suppression; safe with no ledger.

**Final read: one more gap, fixed.** The inbound-id ledger is dev-gated; with it off, releasing the content window would let a same-id retry of an ack clear a second delivery row. → The window is now released only while the ledger is on; with no ledger it is kept (a second genuine ack on a thread inside the window is then answered as duplicate content, as before this change). The reviewer confirmed the reservation covers only the ack's own (sender, thread, text) and that §1 and the lists now match the code. The reviewer re-read the block after this edit and returned **"Concur with the review"**.

Not verified by the reviewer: older-peer behaviour beyond the current tree; listener-daemon mode (now stated in §2 as not covered); whether `ThreadlineRouter` applies its own gate on `/threadline/messages/receive`; the spec text; the tests (the reviewer ran none).

## Evidence pointers

- `tests/unit/threadline/autoAck.test.ts` — recognition, the stage with a real ledger ticket and delivery tracker, limiter, wire format through a real `ThreadlineClient`.
- `tests/unit/threadline/ack-stage-wiring.test.ts` — the stage precedes every side effect and router in the real handler and both HTTP routes.
- `tests/unit/WarrantsReplyGate.test.ts`, `tests/integration/threadline/warrants-reply-funnel.test.ts` — pure-ack before first contact.
- `tests/integration/threadline/ack-never-acked.test.ts` — two handlers back to back, one message; the pre-fix pair looping in the same harness; mixed versions; both HTTP routes.
- `tests/e2e/threadline/ack-never-acked-alive.test.ts` — real relay server, two real bootstrapped agents, one message. Run once against the pre-fix handler pair to confirm it fails there (it does: the wait for "exactly one frame seen" times out).

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action`. The auto-ack is a self-triggered send; across two agents it formed a feedback loop bounded only by a rate limit, and it triggered a session spawn.
- **`closure`** — `guard`.
- **`guardEvidence`** — `enforcementType: ratchet`, `citation: tests/integration/threadline/ack-never-acked.test.ts`, `howCaught`: control-loop edge = agent A's ack arriving at agent B's relay handler (and back); steady-state bound = an ack is terminal at the receiver (`runRelayAckStage` returns before any send), so one message yields at most one ack per side and at most one session in total, independent of horizon; settling brake = the per-sender limiter (5 per 60 s) still bounds acks for real messages. The test drives two handlers back to back until the wire is quiet and asserts exactly two frames; the pre-fix pair in the same harness produces eleven.
