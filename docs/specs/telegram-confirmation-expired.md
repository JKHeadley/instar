---
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
review-convergence: "2026-11-24T15:56:51.489233+00:00"
approved: true
approved-by: "Chief of Staff handoff 5487abe2-0d7b-4dcd-ab5f-403442297112"
---

# Expire confirmation for unverified Telegram sends

A dispatched Telegram send with a recorded ambiguous transport outcome and no correlated receipt remains under observation for 30 minutes from the latest affected attempt's recorded resolution time. Once that window closes, the sender's operation status says, “The confirmation window expired. Delivery is still unverified. Do not resend.” The server keeps the operation ineligible for retry. An in-flight request, an attempt without a usable timestamp, and an ambiguous imported row without a dispatch remain outside this transition.

The execution owner computes the status from its attempt records. The status response and signed owner lookup must preserve the same result. Confirmed receipts retain precedence at every read, including after expiration. Accept later independent evidence only through a source that can correlate the platform's receipt to this exact operation and destination. Topic gaps and text-only matches do not establish delivery or non-delivery. The Bot API cannot look up a sent message without a receipt, so finding one by browsing history is outside this change unless a trustworthy correlation path already exists.

Verify the boundary with a fixed clock, no-retry behavior, propagation through local and remote owner lookup, and a late correlated receipt taking precedence.

The signed response carries an optional confirmation-expiry flag with its existing unknown verdict so older readers can still attribute it to the owner. The new status is shown when the sender checks delivery. If a receipt confirms any part of a multi-part send, the existing partial-delivery result continues to report the parts that arrived.
