# Side-Effects Review — Mutual SSH Autobootstrap

**Version / slug:** `mutual-ssh-autobootstrap`  
**Date:** 2026-07-20
**Author:** Instar-codey  
**Second-pass reviewer:** Claude Sonnet clean-door security review (2026-07-21)

## Summary of the change

This build adds Instar-owned SSH client/host identities, leased paired-peer admission,
a restricted `instar-rpc` ssh2 endpoint, directional proof, bounded health repair,
dev-dark/dry-run configuration, boot integration, and a scrubbed health route. It
touches cryptographic admission and mutual-read invariants but grants no shell access.

## Decision-point inventory

- Bootstrap-advert acceptance — added invariant authority: signed-principal caller
  supplies identity; this validator enforces schema, epoch, expiry, key and private-
  endpoint bounds.
- Peer authentication — added invariant authority: exact leased public-key identity.
- Direction/mutual truth — added invariant authority: current pinned proof exists in
  both directions or `mutual` is false.
- Repair escalation — added bounded deterministic policy; host-key mismatch notifies
  immediately, ordinary failures exhaust four attempts or 120 seconds.

## 1. Over-block

IPv6 private endpoints are not yet admitted by the narrow endpoint validator, so a
private IPv6-only paired host is reported blocked rather than weakened to a public or
unverified bind. Loopback is accepted only for the local real-transport fixture and
never by signed peer advert validation.

## 2. Under-block

The endpoint relies on the exact-pinned ssh2 parser and Node cryptography. Novel
parser vulnerabilities remain possible; the narrow algorithm/channel surface and
dependency audit gate reduce but cannot eliminate that risk. The rollout remains
dry-run-first and fleet-dark.

## 3. Level-of-abstraction fit

The identity, admission, endpoint, verifier, and controller are separate primitives.
Mesh/pairing supplies authenticated public facts; SSH independently proves possession
and reachability. The controller produces transport health and does not become a
parallel routing authority.

## 4. Signal vs authority compliance

Required reference: `docs/signal-vs-authority.md`. Probe outcomes are signals. The
deterministic blocks are cryptographic, structural, expiry, resource, and public-bind
security invariants—the explicitly permitted enumerable-authority case. No heuristic
interprets operator intent or message meaning.

## 4b. Judgment-point check

No competing-signals judgment heuristic is added. Endpoint selection and validity
operate within finite authenticated candidates; uncertainty produces no proof.

## 5. Interactions

- Dedicated state is disjoint from personal SSH state and AgentRegistry ports.
- Pairing epoch, observer boot id, and generations are carried end-to-end; stale
  replay cannot refresh an admission or proof.
- Authentication and subsystem-open both re-read the admission lease.
- The scheduler refuses overlapping sweeps; its concurrency counter and pair breaker
  prevent unbounded work, while successful proof settles the episode.

## 6. External surfaces

The new SSH listener is restricted to loopback/private/Tailscale-style addresses and
exposes no general command surface. The read-only health route omits key bodies and
raw addresses. No operator action is introduced; dry-run/live selection is existing
configuration policy, not a new API-only approval.

## 6b. Operator-surface quality

The Machines dashboard adds a compact SSH-enrollment card. The read surface uses
plain enrollment states (`paired`, `ssh-bootstrap`, `ssh-bootstrap-blocked`,
`ssh-proving`, `ready`) and contains no raw keys or addresses.

1. **Leads with the primary action:** this is status-only, so current readiness and
   enrollment state are the first content; there is no hidden operator action.
2. **Zero raw internals as primary content:** the card shows plain state, direction
   counts, and human-readable blocked reasons; keys, fingerprints, boot ids, epochs,
   and addresses are omitted.
3. **Destructive actions de-emphasized:** no destructive action is exposed.
4. **Plain language + phone width:** the card reuses the responsive Machines grid,
   short labels, and wrapping reason text; it introduces no table or horizontal
   overflow at phone width.

## 7. Multi-machine posture

Machine private keys, host keys, admission leases, and endpoint truth are
**machine-local BY DESIGN** because they are physical credentials and reachability.
Public adverts travel over authenticated Mesh RPC; signed directional proofs replicate
through the coherence journal and are revalidated on receipt. The pool health contract
is **proxied-on-read**. This slice emits no user-facing notice directly and generates
no URL. The fleet-uniform coherence manifest now also covers the effective Mutual SSH
dev-gate plus dry-run value, so a half-enabled pool raises the existing skew alarm
instead of silently presenting asymmetric readiness.

## 8. Rollback cost

Disable the dev gate, drain/close the endpoint, and revert the runtime files. Dedicated
keys and scrubbed audit metadata may remain inert; no personal SSH repair or user-state
migration is required. Removing the state directory later is optional cleanup.

## Conclusion

The implementation preserves the central security boundary: paired-machine identity
is prerequisite, every SSH direction proves itself, and failure stays honestly
non-mutual. Fleet-dark/dry-run rollout contains exposure. Independent review completed
before commit because this touches admission, lifecycle, and a self-action controller.

## Second-pass review

**Reviewer:** Claude Sonnet, clean-door read-only review
**Independent read:** No critical findings. Two major findings were resolved before
commit: host rotation now carries a separately verified MachineAuth transition
signature, and malformed proof timestamps fail closed before freshness checks. Full
dispositions are recorded in `docs/review/mutual-ssh-phase1-security-review.md`.

## Class-Closure Declaration

This closes the `Symmetric Transport Proof` class from the approved spec: the real
transport fixture and mutuality unit test fail any future implementation that claims
mutual from one direction. The self-action loop is bounded by four attempts, 120
seconds, concurrency 4, a three-episode breaker, and a settled proof state; the
self-action convergence ratchet is part of final ceremony evidence.

- `defectClass`: `unbounded-self-action`
- `closure`: `guard`
- `guardEvidence`: `{ enforcementType: ratchet, citation:
  tests/unit/self-action-convergence.test.ts, howCaught: the registered mutual SSH
  repair model is driven under permanent path rejection and proves its four-attempt,
  two-minute episode plus concurrency ceiling and fifteen-minute post-breaker rate
  floor prevent retry accumulation or acceleration }`
