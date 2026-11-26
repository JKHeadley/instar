# App message Delete admission

The admission helper accepts a current signed phone, a recorded conversation owner, and an exact visible event held by the creation custodian. It also checks the current read and delete permissions. It distinguishes invalid bodies from unavailable targets and checks custody before resolving any target ID so a custody failure cannot disclose whether the row exists.

A request namespace binds the signed pairing and current person's durable identifier. An unnamed owner requires a stable account identifier. Reassigning the phone, changing the signed key or switching the unnamed owner's account cannot reuse the original namespace. The exact intent digest includes both conversation and message identity. The helper changes no route, store or history. A private test harness uses production authentication to exercise the checks.

The initial owner-only scope excludes cases where the actor merely authored the message or holds a broader conversation grant. Historical authorship needs stronger evidence than a device's prior signature. Rollback of this checkpoint removes the internal admission helper. Existing clients and ordinary send, history, media and provider paths keep their behavior.

## 6b. Operator-surface quality

The future action takes the selected row from the confirmation and returns a common unavailable response for a missing, unreadable or denied target. The checkpoint exposes no button or mutation.

## Framework generality

Admission reuses signed device identity and People authorization without an agent or model call.
