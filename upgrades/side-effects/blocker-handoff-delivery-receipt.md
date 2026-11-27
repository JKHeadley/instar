# Blocker hand-off, piece 1, slice 1: a settle needs a delivered ask

Tier 2 (spec-driven): docs/specs/blocker-handoff-across-machines-and-surfaces.md, section 1 "Two-phase admission". Approved by Justin on 27 Oct 2026, topic 131439, message 131517; six-round review converged. One production file (`src/monitoring/BlockerLedger.ts`) and one new unit test file. Dark: no caller injects the new store yet.

## Decision and operator impact

`settleTrueBlocker()` accepted `accessRequest.messageRef` as a bounded caller string, so a caller could claim an ask it never sent. The spec requires the ledger to verify a real outbox delivery receipt before a blocker settles, since a settled true-blocker is what later allows fan-out and, as the last rung, remote access.

The change adds an optional `deliveryReceiptStore` (a `DeliveryReceiptLoader` with `loadReceipt(ref)`), mirroring the existing optional `selfUnblockRunStore`. When it is injected, the settle refuses with the new code `missing_delivery_receipt` unless the reference names a persisted receipt that:
- has the same reference and the same ledger entry,
- is in state `delivered` (not `send-intent`, `delivery-unknown` or `failed`),
- has a valid delivery time, no earlier than the failed attempt.

When the store is on, the receipt delivery time is compared with the failed attempt, and the caller-time comparison is skipped. A failed attempt with no time is refused with that reason named. The check runs after the no-new-evidence re-settle check, so a rubber-stamp re-settle is still counted and escalates, and before the Tier-1 settle authority, so a refused ask never reaches the judge. A settle through the store marks its terminal `deliveryReceiptVerified: true`. A settle without the store never carries it, so non-handoff callers keep a compatible path, and later hand-off authority (fan-out, remote access) can require the mark. A throwing store propagates before any write (fails closed), as the self-unblock store does. When the store is absent, behaviour is unchanged: the only edit on that path is the guard on the temporal check.

Claim check: open PR 3865 (Chief of Staff wait intake) touches the same file in a different layer. Its owner confirmed at 06:45 PT on 27 Nov that it has no planned change to settleTrueBlocker, terminal states or reopenForRecheck, and that this seam can proceed on current main.

## Verification and rollback

`tests/unit/BlockerLedgerDeliveryReceipt.test.ts` has 9 cases:
- a delivered receipt settles, the receipt time wins over an earlier caller time, and the authority sees the reference;
- a missing receipt, or one for another blocker, is refused before the authority runs;
- a receipt whose own reference differs is refused;
- intended, unknown, failed and time-less receipts are refused, and the entry stays a candidate;
- a delivery before the failed attempt is refused even when the caller claims a later time;
- with no store, the caller reference still settles and the terminal carries no verified mark;
- a failed attempt with no time is named as such;
- a throwing store fails closed and leaves the entry a candidate;
- a reopened entry re-stamped with the same evidence is still counted, even when its old receipt is gone.

All 5 unit files that import the ledger pass (52 tests). The integration and e2e ledger files do not inject the store, so they exercise the unchanged default. Revert the commit to remove the option; nothing is stored by this change.

## Second-pass review

**Reviewer:** an independent sub-agent with no part in writing the change (read-only), 27 Nov 2026.

Round 1 approved with six points; round 2 (after the fixes) approved, with two small comment and indentation points applied. Fixed in code and tests:
- no compatible path for non-handoff callers once the store is on (now the terminal mark);
- an omitted attempt time blamed on the receipt (now named);
- the receipt check skipping the no-evidence counter (now runs after it);
- test gaps (unused fixture, throwing store, re-settle, missing time).

Carried to the coordinator slice in the piece 1 plan: binding a receipt to its recipient (topic or channel), which belongs with the code that writes receipts. Not covered here: the store combined with the self-unblock run store, where the attempt time comes from the run.

## Class-Closure Declaration

The defect class is claim-vs-evidence: a settle accepted a caller's claim that an ask was sent. The fix makes the evidence a persisted receipt the ledger loads itself, and the tests pin both sides.

unbounded-self-action: closure n/a (negative declaration). This adds a check inside an existing, caller-driven settle call. It sends, retries or triggers nothing.

## 6b. Operator-surface quality

ELI16: docs/specs/blocker-handoff-across-machines-and-surfaces.eli16.md.

No operator-facing wording changes. The refusal text is for agents and logs.
