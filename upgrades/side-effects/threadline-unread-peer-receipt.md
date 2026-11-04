# Side-Effects Review — Threadline unread peer receipt

**Version / slug:** `threadline-unread-peer-receipt`
**Date:** 2026-11-04
**Author:** Echo
**Second-pass reviewer:** independent receipt reviewer

## Summary of the change

The relay inbound handler in `src/commands/server.ts` now emits a non-terminal unread receipt when a trusted peer's message cannot reach a live session. `autoAck.ts` keeps the processed acknowledgment's prior live-reader requirement, and `ThreadlineClient.ts` sends the new `receipt` control type. The trust classifier permits it through the plaintext control path, while the inbound handler consumes it without routing or closing the sender's processed tracker. The cold, warm, and pipe prompts ask a worker to summarize what it read and say what happens next. Ten runtime/test files change, plus review documents. This is Tier 1: a reversible repair with no schema or irreversible state change.

## Decision-point inventory

- Relay routing outcome in `server.ts` — modified: an undelivered outcome produces an unread status, never a processed ack.
- Receipt capability in `server.ts` — added: only advertise the new wire type to peers known to support it.
- Plaintext operation classification in `relayUnknownSenderTrust.ts` — modified: the receipt is a control operation for trust and downgrade checks.
- Inbound receipt handling in `server.ts` — added: consume without spawn, processed ack, or reply loop; surface to the sender's conversation.
- Existing warrants, session admission, and outbound tone decisions — passed through.

## 1. Over-block

No new message is rejected. A peer without the new capability does not receive this status because it would treat it as work. It retains the old acknowledgment path. A peer that disables automatic acknowledgment also does not receive this status, honoring its setting. A sender over the configured five-per-minute receipt limit can miss a status until the window clears; this bounds a trusted peer's flood without spending the separate processed-ack budget.

## 2. Under-block

The status does not repair the session-capacity shortage or guarantee a queued payload survives its in-memory TTL. It explicitly says no session has read the message and asks for a retry if no reply follows. A peer whose discovery record is stale may temporarily look incapable; the server will not risk sending it an unknown control type. A network outage can still prevent the status from reaching the peer; the send failure is logged.

## 3. Level-of-abstraction fit

The relay inbound handler owns the exact handoff result and sender fingerprint, so it is the first place that can state whether a session read the message. The existing router remains the authority for session delivery. The receipt helper only formats and sends the server's observed status. The sender's processed tracker is not changed by the receipt.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).

- [x] No — this change does not add a judgment blocker. The trust gate and router make the existing acceptance and delivery decisions; the new code reports their observed outcome.

The capability check is an exact protocol compatibility condition, not a judgment about message meaning. The type classifier maps a fixed control type to the existing ack trust operation, while the inbound handler still distinguishes unread receipt from processed ack.

## 4b. Judgment-point check

No new static heuristic is added at a competing-signals judgment point. The inputs are enumerable protocol facts: live handoff verdict, trusted sender, and advertised control-type support.

## 5. Interactions

- **Shadowing:** The unread receipt is sent only after the router's undelivered verdict or a listener heartbeat loss. The existing processed ack remains withheld. A later successful handoff can still send the normal ack.
- **Double-fire:** One inbound ID ledger admission owns a message; a repeated relay delivery is deduped. The receipt is a separate control message and is consumed before inbox routing, so it cannot spawn a reply loop on new peers. Its separate flood limit is five per minute by default. The sender may see the later actual reply too; that is intended.
- **Races:** A listener heartbeat may die after a write; the status says unread. A busy-session pending delivery waits for its late verdict; only a failure sends unread. The queue may drain after status, at which point a normal reply can follow.
- **Feedback loops:** A receipt is excluded from reply routing and processed-ack recording. An older peer might not recognize it, so the sender's advertised capability is required.

## 6. External surfaces

Other agents see a short, explicit status instead of silence when this condition occurs. The status can appear in a waiting Threadline send, the sender's canonical inbox, and the linked Telegram topic or Threadline hub. No operator action is added. The wire adds a `receipt` type gated by peer capability; no schema or URL is added. Telegram notices use the relay owner's existing one-voice path. The text does not claim a worker read the request or that the queue is durable.

## 6b. Operator-surface quality

No operator form or dashboard surface is changed — not applicable.

## 7. Multi-machine posture

Machine-local by design for the observation: only the machine currently handling the relay message knows its handoff result. The serving lease makes that relay connection one voice. The receipt goes through Threadline to the sender, so it works across machines. The sender's linked topic/hub notice runs on its own relay owner. No durable state or generated URL is added, and topic transfer does not strand the receipt because the sender reads its current thread binding when it arrives.

## 8. Rollback cost

A code revert removes the new status and returns to the previous silence on undelivered handoffs. No data migration or agent state repair is needed. Already delivered status messages remain visible in peer conversations; they are truthful observations from their send time.

## Conclusion

The regression test demonstrated the original silent path, and the new typed status makes it visible without falsely closing the processing tracker. Capability gating was added after review of older peers' behavior. Independent review found and resolved a missing flood limit, missing server wiring assertions, an uncaught hub promise, and stale queue documentation. Clear to ship through normal gates.

## Second-pass review

**Reviewer:** independent receipt reviewer
**Independent read of the artifact:** concur. The separate rate limit, all undelivered branch wiring, capability guard, no-loop inbound path, and caught hub promise address the review's concerns. Handler coverage is source-based because the boot closure is not importable.

## Evidence pointers

- `tests/integration/threadline/relay-ack-waits-for-delivery.test.ts`
- `tests/unit/threadline/ack-stage-wiring.test.ts`
- `tests/unit/a2a-relay-unknown-sender-trust.test.ts`
- Topic 134156, messages 137741, 137770, 137780

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect. For the self-action scan: `defectClass: unbounded-self-action`, `closure: n/a`. This is one receipt per admitted peer message after an undelivered verdict, not a controller loop. The inbound ID ledger deduplicates replays, the separate five-per-minute sender limit bounds output, and an inbound receipt is consumed without routing. The prompt addition supports the server-side repair; it is not the cause of the silent receipt.
