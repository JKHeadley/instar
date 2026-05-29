# Side-Effects Review — Session Pool Track C(1): MeshRpc envelope + RBAC (L0)

**Spec:** docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md §L0 (approved, review-convergence stamped)
**Track:** C part 1 (the signed m2m command layer — pure core). Ships DARK (no HTTP route wired yet).
**Files:** src/core/MeshRpc.ts (new)

## What changed
1. **`MeshRpc.ts` (new, pure):** the §L0 command layer's correctness core — no I/O.
   - `MeshCommand` (place/claim/release/transfer/capacity-report/session-status/secret-share) + `MeshEnvelope` ({sender, recipient, command, epoch, nonce, timestamp, signature}).
   - `canonicalizeEnvelope` — recipient INCLUDED in the signed bytes (recipient-binding).
   - `signEnvelope` — build + Ed25519-sign (crypto injected).
   - `verifyEnvelope` — the 5-step receipt check IN ORDER: (1) recipient===self, (2) signature valid for sender's registered key, (3) sender is a registered peer, (4) nonce unseen, (5) timestamp within tolerance. Returns a typed reason; does NOT record the nonce (caller records only on full accept, so a rejected command never burns a nonce).
   - `checkCommandRBAC` — the per-command role gate (place/transfer → router; claim → placement-target or failover-router; release → owner or failover-router; reports/secret-share → any peer).
   - `acceptEnvelope` — verify THEN rbac (convenience).
   - Crypto (sign/verify), nonce store, peer registry, and router/ownership reads are all INJECTED seams (like FencedLease's LeaseCrypto).

## Blast radius
- **None at runtime yet.** Nothing imports `MeshRpc` — it ships dark, exercised only by its unit tests. The HTTP transport (`POST /mesh/rpc` + a dispatcher adapting machineAuth's Ed25519 sign/verify + NonceStore + the router/ownership reads) and production wiring land in part 2. Pure additive module.

## Risk + mitigation
- **Risk:** an authorization hole (the whole point of §L0). **Mitigation:** two independent gates (verify = who; RBAC = may), both unit-tested on BOTH sides of every boundary — incl. the spec's headline cases: a command signed for A replayed verbatim to C → `wrong-recipient` (caught at step 1, before signature); a non-router issuing place/claim → `not-router`/`claim-unauthorized`; a stale-timestamp + a reused-nonce → rejected. 15 tests.
- **Risk:** recipient-binding bypass. **Mitigation:** the recipient is part of the canonical signed bytes AND checked first; a verbatim replay to a different machine fails the recipient check before the signature is even evaluated (test: "checks recipient BEFORE signature").
- **Risk:** a rejected command consuming a nonce (DoS). **Mitigation:** verifyEnvelope is pure (reads `seenNonce`, never records); the caller records the nonce only on full acceptance.

## Migration parity
- None in part 1 (pure module, unwired, no config). The `meshRpcClockToleranceMs` config knob + any route config land with the HTTP wiring (part 2) via the `multiMachine.sessionPool` ConfigDefaults path.

## Rollback
- Additive + dark + unwired. Delete `MeshRpc.ts` to revert; nothing depends on it.

## Tests
- tests/unit/MeshRpc.test.ts (15) — recipient-binding in the canonical bytes; verify (happy + wrong-recipient replay + bad-sig + unknown-sender + replayed-nonce + stale-timestamp + recipient-before-sig ordering); RBAC both sides for place/transfer/claim/release + read-class; acceptEnvelope verify-then-rbac ordering. tsc clean.

## Agent awareness
- No user-facing surface in part 1. The m2m backbone is internal infra; agent awareness for the session pool is covered by Track B's CLAUDE.md blurb. <!-- tracked: session-pool-track-c -->
