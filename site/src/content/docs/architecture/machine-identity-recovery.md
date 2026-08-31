---
title: Machine Identity Recovery
description: How paired machines recover a lost signing identity without trusting the shared bearer token or requiring routine human repair.
---

A machine signing key can disappear while the machine itself remains legitimate. The
recovery path separates ordinary mesh authentication from long-lived identity continuity:
pairing pins a recovery root whose private key lives in a genuine operating-system
keychain, outside the machine identity directory.

The feature ships disabled on the fleet and dry-run-first on development agents.

## Authority and storage

`MachineRecoveryKey` creates and uses the keychain-only recovery root.
`IdentityStore` is the single authority for signing and recovery epochs, tombstones,
revocation, quarantine, and first-hand versus replicated provenance.
`MachineOperatorDelegation` signs exact recipient, action, subject, epoch, content, and
expiry grants for operator-authorized changes. `IdentityRecoveryRootRotationTransaction`
makes recovery-root replacement crash-atomic across its seven durable boundaries.

`MachineIdentityActivationGate` keeps mutation disabled until every active peer has
authenticated, fresh, exact-mode presence. `MachineIdentityBootRecovery` reconciles
unfinished identity transactions before normal startup can advertise or mutate identity.

## Recovery exchange

`IdentityReannounce` owns the deterministic accept, quarantine, and refusal authority.
It requires an exact next epoch, replacement-key possession, recovery-root continuity,
revocation safety, and coherent peer projections. `IdentityReannounceClaimant` owns the
durable retry episode: attempts are persisted before network I/O, backoff widens from one
minute to six hours, and the episode settles after a 72-hour horizon.

`IdentityRecoveryBearer` supplies a nonce-bound encrypted bootstrap view to a legitimate
recovering peer. `IdentityProjectionEnvelope` signs current promoted identity projections
for peer agreement. `IdentityDivergenceMonitor` compares those authenticated projections
and reports a conflict without independently changing authority.

## Propagation and acknowledgement

`IdentityRecoveryRootPropagation` distributes an operator-authorized root change without
turning ordinary machine authentication into operator authority.
`IdentityPropagationTransport` carries signed mutations and receipts over the existing
mesh paths. `IdentityPropagationReceipt` binds the recipient and applied content, while
`IdentityAckPropagation` keeps accepted signing changes visible until every required peer
has acknowledged the exact epoch and fingerprint.

## Endpoint evidence

`ObservedEndpointTracker` records the private source address of authenticated traffic in a
bounded, expiring local evidence set. The observation is deliberately non-authoritative:
address shape and dial-back success cannot prove which Tailscale node owns the connection.
Existing proven routes remain usable, but endpoint promotion waits for cryptographic node
provenance.

## Operator surface

The Machines dashboard reports recovery-root availability, accepted changes awaiting
acknowledgement, and quarantined claims. Approve and deny actions are PIN-session-bound to
the exact canonical claim hash. A generic bearer token cannot approve a claim, establish
the first root, rotate a root, clear revocation, or write protected identity files.

