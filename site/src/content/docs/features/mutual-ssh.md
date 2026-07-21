---
title: Mutual SSH Health
description: Automatic restricted SSH bootstrap and two-direction reachability proof for paired machines.
---

Instar can establish its own restricted SSH transport between paired machines without
using personal SSH keys or enabling an interactive shell. The feature starts fleet-dark
and dry-run first.

`MachineSshIdentity` owns dedicated client and host Ed25519 generations.
`SshPeerAdmissionStore` admits only the exact leased public key associated with the
current pairing epoch, boot, and generation. `MachineSshEndpoint` accepts only the
`instar-rpc` subsystem and rejects shell, exec, PTY, forwarding, SFTP, passwords,
public binds, stale admission, and oversized frames.

## Mutual means both directions

`MutualSshVerifier` validates pinned challenge results produced by the actual source
machine. A pair is healthy only when A→B and B→A proofs are both fresh. One direction
never implies the other.

`MutualSshRuntime` exchanges signed `SshBootstrapAdvert` records over the authenticated
machine mesh, runs the endpoint and proof lifecycle, replicates signed proof evidence,
and exposes scrubbed readiness. `MutualSshProbeScheduler` bounds concurrency and verifies
that the configured sweep fits inside proof freshness. `MutualSshHealthController`
classifies failures and applies bounded retries plus a per-pair breaker.

## Rotation and failure posture

`SshHostKeyLifecycle` requires a separately signed transition from the previously pinned
host generation before accepting a rotation. Changed keys otherwise fail closed and raise
a security notification. Revocation drains active peer sessions, while restart, epoch,
boot, generation, expiry, and replay fences prevent old evidence from restoring readiness.

