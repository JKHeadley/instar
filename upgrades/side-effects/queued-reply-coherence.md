# Side-Effects Review — Queued reply coherence

**Version / slug:** `queued-reply-coherence`
**Date:** 2026-11-04
**Author:** Echo
**Second-pass reviewer:** independent review agent

## Summary of the change

The Telegram origin recovery tick and forward retry ladder check local and pooled topic history before sending an unaccepted saved session reply. A newer user or agent message retires the old operation through the existing durable `suppressed` transition. Incomplete pool coverage holds the reply for a later review. Automated notices do not count. A forwarded unknown outcome first reconciles at the former holder; definite nonacceptance clears the uncertainty and waits for a new chronology review before another dispatch. A holder replacement carries the original session label and draft time in the durable hold, so it receives the same review. Topic-name lookup stops sending a temporary dot and relies on captured names or fallback labels. The changed decision points are in `TelegramOriginRuntime`, `OriginForwardToHolder`, the server's history callback, and `TelegramAdapter.resolveTopicName`. This is a narrow runtime repair with focused unit and integration tests; the competing PR #2775 changes inbound failover reconciliation and is not touched.

## Decision-point inventory

- **Queued origin recovery and forward retries** — modify — a saved, unaccepted reply is retired when later user or agent messages in the same topic have already appeared. This is a transport ordering invariant over observed chronology, not a judgment of the draft's meaning.
- **Topic-name lookup** — modify — missing names retain fallback labels; no network message is sent to discover a label.
- **Origin store suppression** — pass-through — uses the existing transaction and fencing; no new state or writer.

## 1. Over-block

A user can send a new, unrelated question while an earlier answer is queued. The earlier answer will be retired, so they may need to ask for it again. This is the cost of enforcing chronological delivery when the queued draft cannot be rewritten by its original session. The rule applies only to unaccepted recovery candidates, only within the same topic, and never from automated notices. A partially delivered reply is preserved.

## 2. Under-block

An unknown former machine missing from the current peer list can leave the pooled view falsely complete; the existing pool route has that coverage limit. A send that crosses the check and Telegram dispatch while a new message arrives in the same moment can also escape. Uncertain outcomes are not suppressed because Telegram may already have delivered them. After the former holder confirms nonacceptance, the next recovery tick may retire the reply. A full pooled page containing only later automation holds the reply rather than searching further back, so it may wait until its existing deadline.

## 3. Level-of-abstraction fit

Recovery owns whether an old queued operation is still eligible to send. The Telegram adapter and existing `/telegram/topics/:topicId/messages?scope=pool` route supply the platform history, and the origin store owns the terminal state. The shared gate runs after the direct and forwarded recovery scheduler selects a candidate and before network I/O. The forward path first settles an uncertain receipt and returns without dispatch, so the next tick can review chronology. Name lookup is corrected at its source instead of filtering dots later.

## 4. Signal vs authority compliance

Required reference: [signal-vs-authority](../../docs/signal-vs-authority.md). The chronology rule is a transport invariant: an unaccepted queued reply must not be delivered behind a newer conversational message in that topic. It does not infer whether the text is true, useful, or similar. The existing tone gate continues to judge message content. The origin store alone holds terminal suppression authority and refuses an active claim or partially accepted operation. No new brittle semantic filter is added.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals judgment point. The decision is limited to an observed same-topic ordering violation on an unaccepted recovery operation. Where evidence is absent or the pool read fails, the callback holds the candidate until a later recovery tick.

## 5. Interactions

- **Shadowing:** the check runs only in origin recovery and the forward retry ladder, before the existing send-policy and transport path. It cannot suppress a first-attempt interactive reply.
- **Double-fire:** `recordOperationState('suppressed')` is terminal and transactional; later ticks do not recover that operation.
- **Races:** the store refuses suppression if an operation is already claimed, accepted, or partially delivered. A refused transition is not treated as successful retirement. A forwarded unknown or local send marker is reconciled or held, never suppressed as definite non-delivery.
- **Holder replacement:** a newly prepared replacement may be labeled server automation because recovery has no live session scope. The durable hold preserves the original session label and draft time, which the shared gate uses for every later attempt. The recovered message also uses that original label when recorded in topic history, so it can supersede a later queued reply.
- **Feedback loops:** automated delivery notices are excluded from the chronology signal, so they cannot retire the reply they report.

## 6. External surfaces

People stop seeing stale queued replies and the temporary dot probe. Older topics with no captured name may show `topic-N` until a real topic event supplies the name. The operation state uses existing durable storage; there is no schema migration or new API. No operator-facing action is introduced.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Proxied on read for conversation evidence:** the recovery callback reads this machine's history and the existing pooled topic-message route before allowing a saved reply. A failed peer or a full page that does not reach the draft time holds the reply for a later attempt. Each origin outbox itself remains source-machine-local because its sealed operation and transport authority live there; the existing serving lease and forward path handle topic transfer. This change emits no user-facing notice, new URL, or replicated state. No `/status`, `/health`, `/capabilities`, or `/channels` answer changes.

## 8. Rollback cost

Revert and ship a patch; there is no migration. A reply suppressed during this version remains suppressed, because the choice was made durably. The user can request that answer again if needed. Older unknown topic labels regain the dot-probe behavior on rollback, so that part should be reverted only if a safer name source is available.

## Conclusion

The check addresses the concrete late App and Baton replies before transport, and removing the probe addresses the dot. The accepted-message and unknown-outcome guards preserve the existing receipt safety rules. Focused tests cover chronology, automation notices, a live recovery tick, both forward retry paths, receipt uncertainty, and both local and forwarding topic-name lookup. The independent reviewer concurs with the revised flow.

## Second-pass review

**Reviewer:** independent review agent
**Independent read of the artifact:** Concur with the review. The first pass found that the forwarded recovery branch and the five-second ladder initially bypassed the chronology gate. Both now use the shared gate. Uncertain forwards reconcile first; after definite nonacceptance they wait for the next chronology review. The reviewer confirmed the historical unknown attempt does not bypass that review. The reviewer then found that a holder replacement could lose its original author in topic history; the recovered history paths now use the preserved author. The final pass checked capture, supersede carry, both retry paths, and history provenance and found no remaining author or time loss. The pool roster limitation remains documented above.

## Evidence pointers

- App message 138292: prepared 2026-11-05 02:08:47Z, accepted 02:36:11Z after Justin's 02:08:50Z answer and Echo's 02:11:46Z correction.
- Baton message 138298: prepared 02:00:41Z, accepted 02:41:07Z after the 02:32 correction.
- Bugs hub message 1803: origin producer `telegram-server`; `TelegramAdapter.resolveTopicName` sent the literal dot.

## Class-Closure Declaration

For the `unbounded-self-action` class, closure is **guard**. The recovery controller already has a bounded six-hour deadline, reserved attempts, and a forward ladder registered in `src/testing/selfActionRegistry.ts` (`telegram-origin-forward-ladder`). This change adds one terminal transition (`suppressed`) and no new repeat action. Under sustained newer-message pressure, an operation is retired once and cannot emit repeatedly. The existing self-action ratchet checks the ladder bound, and the new recovery tests check suppression and receipt reconciliation.
