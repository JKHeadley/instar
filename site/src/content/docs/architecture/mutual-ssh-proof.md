---
title: Mutual SSH Proof Architecture
description: Security boundaries and component ownership for Instar's paired-machine SSH subsystem.
---

The Mutual SSH subsystem separates authenticated bootstrap facts from transport proof.
Pairing authorizes public-key exchange; it does not claim reachability. Each source machine
must independently complete the restricted SSH challenge against a pinned host key.

## Component boundaries

- `MachineSshIdentity` creates machine-local client and host credentials and fences corrupt
  or incomplete generations.
- `SshBootstrapAdvert` validates the signed public bootstrap schema, private endpoints,
  pairing epoch, boot identity, generations, and host-key transition signature.
- `SshPeerAdmissionStore` persists exact, expiring client-key admissions and actively
  revokes sessions when a peer is removed.
- `MachineSshEndpoint` is the SSH parser and resource boundary. Its only application
  channel is `instar-rpc`; it is not a general remote-login server.
- `MutualSshVerifier` produces and checks directional proof with wall-clock and monotonic
  freshness, source identity, target host generation, challenge, and signature fences.
- `MutualSshProbeScheduler` enforces the sweep capacity and concurrency ceiling.
- `MutualSshHealthController` owns bounded retry classification, escalation, and breakers;
  its observations never become routing authority.
- `MutualSshRuntime` composes bootstrap, admission, endpoint, journal evidence, readiness,
  rollback, revocation, and ordinary repair.
- `SshHostKeyLifecycle` admits only a valid old-key-to-new-key transition during the bounded
  overlap window and retires the previous generation after proof or timeout.

The invariant is deliberately strict: missing, stale, one-sided, replayed, or mismatched
evidence means the pair is not mutually verified. The physical two-host rollout proof is a
later rollout gate; it does not weaken the phase-1 implementation or its dark default.
