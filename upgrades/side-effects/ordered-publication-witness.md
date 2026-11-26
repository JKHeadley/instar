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

## Predecessor prefix verification

The verifier consumes already authenticated seal metadata and the predecessor identity resolved independently from lease history. It recomputes the framed digest over a contiguous, canonical byte sequence. Its verdict describes prefix completeness and grants no write or handover permission. Resolving an uncertain append still requires exact authenticated reconciliation.

## Uncertain append reconciliation

The verifier consumes authenticated evidence and independently resolved current manifest identity. Only an exact positive reconciliation matched to the canonical row returns reconciled. The verifier never clears a durable intent, retries an append or enables an effect. Signed synthetic vectors cover unknown, exact, mismatched, replayed, delayed and unavailable inputs.

## Independent floor readback

The read boundary binds the receiver-selected destination, namespace, Git commit and fresh nonce to the witness-signed floor. It checks the ref and witness enrollment again before returning local evidence. The transport must provide authoritative observations and the witness must inspect the challenged commit independently. A readback grants no final publication permission. No production transport is installed by this checkpoint.

## Direct Git ref observation

The read-only adapter checks an exact, receiver-pinned repository and ref twice around witness confirmation. It ignores checkout state and inherited Git configuration. Missing, ambiguous and timed-out reads give no floor. This checkpoint has no production credentials or callers. A disposable bare repository exercises the read path.

## Witness responder

The responder checks transport-authenticated caller permission and receiver-owned destination and scope. It signs only the exact challenge after reading the matching accepted snapshot for its own witness identity. The repository integration exercises both ends with a disposable key and an injected accepted snapshot. The durable snapshot provider and authenticated deployment transport remain separate.

## Witness snapshot persistence

One SQLite WAL/FULL transaction stores the exact commit and floor after a trusted adapter verifies acceptance. An exact retry is recognized and a stale predecessor is refused. The integration connects the disposable Git reader to the responder and reopens the witness database before validating its reply. Physical independence, rollback custody and the adapter authorized to write accepted snapshots are deployment requirements.

## First-phone attempt reservation

The dark witness records the exact payload digest and observed commit beside the ordered floor update in one transaction, keyed by agent, namespace and attempt. A historical retry of the exact winner returns existing. Competing outcomes remain conflicts after holder handover. The synthetic Identity fixture exercises both arrival orders and an older reopened receiver. The trusted adapter still owns the exact Git observation and first-phone semantics. No registry or app effect is wired.

## Shared first-phone slot and key lineage

Compound decisions compare the full current slot state and append the operation, receipt, slot update and floor in one transaction. Both enrollment and replacement use the same storage lock. Generic machine-key-history decisions fail closed for agents with a provisioned compound slot until other key operations have explicit shared projections. Historical recovery accepts only an exact canonical decision. Final live registry mutation must independently compare the current generation and accepted head and use the exact accepted projection. This checkpoint installs no registry writer or mobile route.

## Observe and retain exact first-phone evidence

The default-off observer has only the staging operation and checks the pinned Git ref again after loading candidate evidence. The immutable candidate row keys on scope and commit and preserves the original bytes. Compound first-phone acceptance checks those exact bytes inside its transaction. Recovery requires the corresponding historical operation receipt and exact digest. Tests use real disposable Git refs and an injected immutable-object reader. No witness service loop, production object reader, or route is enabled by this change.
