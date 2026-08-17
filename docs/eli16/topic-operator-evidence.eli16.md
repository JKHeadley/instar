# A verified operator now needs evidence — in plain English

## What was wrong

Instar keeps a small record saying who the verified operator of each conversation is. That record is important: other code uses it to decide whose approvals, mandates, credentials, and instructions carry operator authority.

There were two ways to write the record. A real Telegram message came with a sender identity that the Telegram adapter had authenticated and authorized. But a general API route also accepted any non-blank `uid` written in its request body. Both paths stored exactly the same provenance: `authenticated-inbound`.

That meant the record did not preserve how it was established. A caller could post a content-like name such as `arbitrary-content-name`, and the stored row claimed that it came from an authenticated inbound sender. Downstream code could not distinguish real authentication evidence from a caller's assertion.

## What changes

Every raw binding now records both an honest provenance and establishment evidence.

The two real Telegram ingress paths mint evidence only after their existing `isAuthorizedSender` check. The evidence names the ingress path, the authorization check, the authenticated sender uid, and the concrete inbound message id. The verified reader independently checks that the evidence is complete and that its sender uid matches the binding's uid.

The manual API remains available so existing tools can record and inspect a proposed or administrative binding. Its output is now explicitly labelled `operator-api-assertion`. It is visible through the raw-binding read surface, but every reader that means “verified operator” returns null for it. Manual assertions also do not replicate as verified operator records.

Legacy rows that say `authenticated-inbound` but carry no evidence are treated as not proven. They are not deleted. The next authorized Telegram message for that topic writes a new evidence-bearing binding through the normal live path.

## Why this is safer

A provenance string is testimony; it is not evidence. The new predicate does not trust the row's label by itself. It requires a recognized authenticated ingress, the named authorization decision, a matching sender uid, and a non-blank message id. Missing, malformed, mismatched, asserted, and legacy inputs all resolve to “not verified.”

The real route tests drive both sides. Posting an arbitrary body uid produces a durable assertion and no verified operator. Sending an authorized Telegram message produces a durable verified binding with path-derived evidence. Unauthorized senders, agent-to-agent bot traffic, blank evidence, and forged self-reports do not become verified operators.

## What remains the same

The normal operator experience does not gain a new step. Authorized Telegram traffic continues to bind automatically. Session-start context, principal-coherence checks, bias-to-action resolution, and other verified consumers continue to use the same store APIs; those APIs now refuse records that cannot prove how they were established.

The local binding remains the only authoritative answer on each machine. Cross-machine replication stays advisory and untrusted. This change narrows authority; it does not add a new source of it.
