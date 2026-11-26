# Telegram inbound custody status side-effects review

## Summary of the change

Server acceptance and lifeline replay produce receipt wording. The durable queue reports waiting on a new enqueue and expiry on terminal custody. The session acknowledgement projects only exact observed transcript evidence from the existing delivery journal.

## Decision-point inventory

Lifeline HTTP acceptance is a receipt. Waiting follows a successful new queue entry. Expiry means local custody stopped without confirmation. Session delivery needs the exact topic, incoming message identity, and consumed or responded journal row.

## 1. Over-block

Messages without verifiable transcript evidence can still be processed normally and get receipt or queue status. Confirmation notices can be omitted when the in-memory acknowledgement map is full or restarted.

## 2. Under-block

A successful transport response, queue terminal marker, replay, or unobserved injection cannot produce a delivered badge. Ambiguous expiry states no receipt was confirmed.

## 3. Level-of-abstraction fit

The lifeline describes its handoff. The queue describes its custody. The session monitor projects evidence the journal already owns.

## 4. Signal vs authority compliance

These outbound status notices do not cause retries, close unanswered messages, or assert a session effect. An existing trusted internal automation producer path and a platform message identity label each new numbered status.

## 4b. Judgment-point check

All labels derive from observed transitions. No model infers delivery from a subsequent reply or from content similarity.

## 5. Interactions

Exact status templates remain system notices across adapter and holder relay paths. A stale notice about one message cannot close a newer unanswered turn. The positive notice is opt-in to available evidence.

## 6. External surfaces

Telegram receives status copy under the existing delivery machinery. The status producer has a per-topic budget and **does not** grant verified-reply authority or push routing. During a burst, the budget may keep excess statuses in notification history instead of posting each one in the topic.

## 7. Multi-machine posture

Each queue or transcript observer speaks to its own evidence. Relays preserve authenticated automation provenance. A source that only receives a peer transport acknowledgement cannot claim session delivery.

## 8. Rollback cost

Revert the notice and projection wiring. Queue records, the session journal, and existing custody behavior are compatible.

## Conclusion

The badge reports only what each component can establish.


## Class-Closure Declaration

The convergence ratchet covers the `unbounded-self-action` defect class. Waiting is emitted only for a newly queued row. A terminal expiry retires that row. An observed handoff consumes a bounded tracker entry and can emit once. None of these status notices triggers another delivery attempt.


## Second-pass review

Concur with the revised change. Exact custody notices preserve unanswered-message tracking in the adapter and in the relay holder’s reply route. Expiry wording reflects the evidence. Budgeted visibility is documented.
