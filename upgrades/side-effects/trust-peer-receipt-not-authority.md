# Side effects: peer receipts are never the owner's reply (SEC-088)

## What changes for running agents
- Multi-machine agents with the trust journey on: an owner reply that reaches a non-holder (only during a lease handover, since the holder polls the chat) is no longer carried to the holder. The owner gets one plain line asking them to send it again. This is a small UX cost in a rare window, accepted to remove a forgery path.
- Receipts already in the replicated store from before the update are not processed by the holder.
- Single-machine agents: no change (that machine is always the holder).
- Mixed versions during rollout: an older non-holder still writes a receipt and stays silent, and an updated holder drops it, so that one reply is lost without a resend request until every machine is updated.

## Signal vs authority
A replicated record is the writing machine's claim (a signal). The authority for "the owner replied" is the holder's own adapter receiving it from the platform.

## Rollback
Revert the commit. No stored data changes.

## Not covered here (this is a PARTIAL fix of SEC-088)
The independent review found that `onPeerRecords` -> `store.applyCommitted` folds EVERY replicated record type into the holder's state without knowing who wrote it. Closing the receipt path leaves these open:
- `action-approval` (critical): a forged record makes `admit()` return proceed-once for the governed action it names.
- `legacy-grant` + `change` (high): a forged pair makes admission treat a kind as unchanged legacy, which is ungated.
- `change` + `consumption` (high, only when stored settings are corrupt): the load-time rebuild trusts a forged consumption.
- `acceptance` (medium): skips the owner's acceptance step (a real approve is still needed). `device-acceptance` and `device-approval` are folded unauthenticated too.
- Denial: pre-written receipts for predictable update ids, or forged `consumption`/`request-status`, swallow or close real requests.
These records also come legitimately from peers (a new holder relies on what the previous holder wrote), so they cannot simply be dropped. They need provenance: spec `trust-journey-record-provenance` (draft). SEC-088 stays open until that lands.
SEC-090 (forwarded organization admin operations) has its own spec, `org-forward-owner-signed` (draft).

## Second-pass review

Round 1 (whole-finding scope): independent second-pass subagent (fresh context, read-only): OBJECT, because the fix is partial, for the reasons above. It confirmed the receipt path is closed for Telegram and Slack ingress, that the non-holder reply is gated to the owner's own direct chat (no leak or spam vector), and that `instruction-sent` is consumed correctly by the forward route. This PR ships as the receipt-path part only.

**Reviewer:** independent read-only subagent (fresh context, 2026-11-18 01:00 PST), asked the scoped question "is this receipt-path part correct and safe to ship on its own, with the remainder tracked": CONCUR. All three ingress paths (lifeline forward, Telegram getUpdates, Slack) reach `ingest()`, which on the holder only calls `onReceipt`; `onPeerRecords` now only logs. The non-holder path writes nothing and replies once, only in the owner's direct chat. No regression for single-machine agents; the remaining record types are not made worse. Tests would fail on revert. Notes taken: the mixed-version line above; a forged receipt on a predictable key still marks a real reply duplicate (already listed under denial, covered by part 2 decision 5).
