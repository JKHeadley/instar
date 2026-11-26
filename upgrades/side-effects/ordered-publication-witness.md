# Ordered publication witness receiver checkpoint

## Summary of the change

Tier 1 dark source checkpoint. The source validates exact ordered receipts and witness transfer against an independently confirmed floor. There is no production receiver or callback. This is the first commit attempt, following the prior fixture and interface review.

## Decision-point inventory

Local receipt recording requires a configured enabled receiver, pinned witness signature, exact staged bytes, exact independently accepted successor, and a matching local holder generation with no pending handover. An ordered scope cannot use the legacy claim or activation path. Witness transfer requires both signatures on the exact existing floor and confirmed successor floor.

## 1. Over-block

An unavailable witness, restored prefix mismatch, or unresolved pending handover leaves the operation pending. Recovery of a lagging projection needs the missing verified transitions.

## 2. Under-block

A stale or improperly trusted independent reader could misrepresent currentness. The composition has no live reader, and no caller interprets a receipt as permission to dispatch. Deployment requires independent custody and a final authority check at publication.

## 3. Level-of-abstraction fit

The witness proves the exact transition. The SQLite transaction reconciles local historical evidence. Namespace callers retain their business policy.

## 4. Signal vs authority compliance

The independent ordered authority supplies the accepted floor. The local database verifies and records evidence. A local receipt alone has no external effect.

## 4b. Judgment-point check

Signatures, scope, journal order and exact byte digests are deterministic predicates over receiver-owned evidence. The product meaning of each command stays with its namespace.

## 5. Interactions

Existing local scopes retain their original behavior. This checkpoint introduces a separate storage row for each opted-in scope. Ordered decisions are restricted to Needs-you and mobile ingress. The shared scope type still enumerates all four namespaces.

## 6. External surfaces

No routes, network writes or production config changes. Roll back by reverting the dark checkpoint before adoption.

## Holder activation checkpoint

A prepared order-plus-witness scope can complete only if its current witness signed the predecessor floor, successor and seal digest, and the independent journal reports the resulting exact floor. Matching the pending database row and advancing its floor are one transaction. The transport still owns validation that the seal represents the last possible predecessor effect and resolves outstanding intent. The local store relies on that independent attestation.
