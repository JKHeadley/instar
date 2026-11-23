---
title: Two Durability Corrections For Exact Reminder Settlement
tier: 2
approved: true
approved-by: Echo after scoped no-finding confirmations under Chief 002e4dff
eli16-overview: docs/specs/profile-reply-context-followup.eli16.md
full-convergence: false
review-mode: operator-delegated-bounded-closure
operator-authorization: Chief of Staff handoff 002e4dff-4d57-49ee-981c-8369ce5c8f00
---

# Bounded Confirmation

The Chief authorized one external and one internal confirmation of exactly the following two corrections and their deterministic negative tests. This is not another general audit or a full convergence claim. A new safety or data-loss defect stops the build and returns to the Chief; there are no further rounds under this authorization.

## 1. Roll Back Every Failed Store Write

NeverSilentStore currently mutates its live object before synchronous flush, so failed release or reply bookkeeping can remain in memory and leak into a later successful accept. Keep a deep snapshot of the last successfully loaded or committed store. Every write path continues through the single synchronous flush boundary. Only a successful atomic rename advances that snapshot and the ordinary-write progress revision. If pruning, mkdir, writing or renaming fails, restore the entire live object from that committed snapshot before rethrowing. Do not update the committed snapshot or successful-write revision on failure. Initial missing/corrupt storage has no invented committed obligation. Existing single-writer, no-await execution remains unchanged.

Tests inject actual write or rename failures into ordinary release, recordReply and accept, then inspect memory and the persisted JSON. In failed release followed by a successful unrelated accept and a registered reminder, the genuinely unanswered neighbor must remain pending in memory and on disk. A queued next-turn inbound runs only after rollback and cannot be overwritten. Successful normal writes retain their current behavior.

## 2. Retain Exact Delivered Proof Through Same-ID Admission

An actual registered reminder is linked to its exact owner input by the server-private claimed binding. If that obligation is missing because monitoring acceptance failed, retain the immutable exact delivery proof in the active monitor instead of discarding it or inventing an obligation. Report pending bookkeeping while that proof awaits real matching admission. No obligation is created by the receipt. Only a real subsequently observed inbound with the same platform, source and native message ID can create that obligation through the ordinary accept path. Its successful commit supplies storage-progress credit; reconcile the retained proof before unanswered judgment. While proof is retained, the known-delivered exact input is not an unanswered subject. All unrelated inputs remain eligible. Retire proof only after a committed exact settlement or an established committed terminal result. A disabled monitor remains not-required; failed monitor initialization remains unavailable without promising a nonexistent sweep.

Tests cover failed accept, actual private-bound registered delivery, real redelivery of that same native input, successful admission and watcher sweep. Assert the truthful platform receipt, pending then recorded bookkeeping, exactly one original send and one handle claim, durable answered state for that input, no false unanswered notice, and a genuinely unanswered neighbor that still receives its existing notice. Duplicate receipt/redelivery is idempotent. Wrong source, ID, principal, guessed handle, no handle, inactive/unregistered delivery and unknown/refused transport cannot create this proof or settle anything. Existing progress-gated batching, immutable admission fences and no-consent-change rules from the parent draft remain unchanged.

# Boundaries

The store is an existing synchronous single-writer object using writeFileSync and renameSync. These corrections add no asynchronous writer, consent rule, owner-turn issuance or spending rule, general acknowledgment, independent timer or transport retry. This snapshot is application atomicity, not an fsync/power-loss guarantee. The private delivery binding remains local to the serving generation; restart/transfer recovery is tracked by ACT-457 and is not certified here. The first signed Telegram FAIL remains preserved. Implementation tests and a fresh complete small live matrix are required after this bounded confirmation.
