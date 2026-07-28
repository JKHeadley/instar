# Side-Effects Review — Reliable Peer-Machine Execution

**Version / slug:** `reliable-peer-machine-execution`
**Date:** 2026-07-22
**Author:** Instar-codey
**Second-pass reviewer:** independent Codex security review

## Summary of the change

ACT-897 extends `MutualSshRuntime` so a peer advert that has fresh, current-epoch
proof in both directions can reconcile its dedicated key into the current agent
account's `authorized_keys`. It adds `PeerAuthorizedKeys`, a separate dev-gated
`multiMachine.peerExecution` dry-run-first posture, a signed real-sshd endpoint,
pinned-host-key execution probe, named readiness failure, N5
coherence and guard-manifest coverage, and lifecycle tests.

## Decision-point inventory

- Mutual proof authority — modified — fresh bidirectional proof now gates a standing grant.
- Managed key reconciliation — added — exact peer identity/epoch/generation selects one labeled line.
- Readiness — modified — required standing access fails loudly when proof or installed key is absent.

## 1. Over-block

Non-Ed25519 keys, symlinked SSH paths, and peers without two fresh current-boot
directions are refused. Those are intentional security invariants. A host whose OS
SSH daemon is disabled remains honestly unreachable.

## 2. Under-block

The installed line grants the same account access the host's sshd configuration
allows; this code does not narrow sshd commands. The feature therefore stays
fleet-dark and dry-run-first pending explicit rollout. Host-level SSH configuration
outside the account key file remains operator policy.

## 3. Level-of-abstraction fit

`MutualSshRuntime` remains the authority because it owns signed adverts, pairing
epochs, generations, and both proofs. `PeerAuthorizedKeys` is a narrow effect
primitive and cannot decide trust. No parallel pairing or key store is introduced.

## 4. Signal vs authority compliance

Probe and advert data are signals. The blocking authority is the existing enumerable
cryptographic invariant: exact paired principal, current epoch/generations, live boot
ids, monotonic freshness, and both directions. No brittle semantic heuristic decides.

## 4b. Judgment-point check

No competing-signals judgment point is added. Authorization is a finite security
predicate; uncertainty must refuse the grant.

## 5. Interactions

- Rotation replaces the prior managed machine line instead of accumulating access.
- Peer removal and epoch advancement revoke managed access with proof/admission cleanup.
- Atomic rename prevents partial canonical files; repeated reconciliation is idempotent.
- Dry-run audits the intended effect without creating `.ssh` or the file.

## 6. External surfaces

Persistent account SSH authorization changes only when both the feature and
`dryRun:false` are explicit. Health exposes a scrubbed machine id reason, never key
bodies or home paths. No new external API or operator action is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**machine-local BY DESIGN:** each machine owns its own account key file and physical
reachability truth. Signed adverts/proofs cross the existing mesh; effective posture
is fleet-uniform via the machine-coherence manifest. It emits no direct user notice,
holds no transferable topic state, and generates no URL.

## 8. Rollback cost

Force-dark `multiMachine.peerExecution`, then revert. Managed labeled lines are
removed through normal peer revocation; an emergency rollback can remove only those
labeled lines. Operator-managed lines are never selected. No database migration.

## Conclusion

The effect is attached to the existing mutual verifier, scoped to a single account
file, replay/rotation/revocation fenced, visible in readiness, and contained by
fleet-dark plus dry-run-first rollout.

## Second-pass review

**Reviewer:** independent Codex security review
**Independent read:** concur after three disposition rounds. The review first
rejected restricted-subsystem-only health, cross-agent line collisions, incomplete
revocation, weak key parsing, and filesystem-error handling; then required
target-digest-bound evidence and serialized writes; finally required ownership-safe
dead-lock recovery. The final diff uses a real pinned sshd exec proof, agent+machine
line ownership, current-boot/off-gate revocation, parsed keys, named failures,
PID+nonce locking with liveness-checked recovery, and token checks before rename and
release. Final verdict: APPROVE, no release blockers.

## Evidence pointers

- `tests/unit/peer-authorized-keys.test.ts`
- `tests/unit/mutual-ssh-autobootstrap.test.ts`
- `tests/unit/machine-coherence-manifest.test.ts`
- `tests/unit/lint-dev-agent-dark-gate.test.ts`
- `tests/unit/lint-guard-manifest.test.ts`

## Class-Closure Declaration

- `unbounded-self-action` — closed by guard. Per-machine authorization mutations
  are event-driven and idempotent; repair attempts are capped by the existing
  ten-machine sweep and bounded repair breaker, while startup, disable, rotation,
  and revocation settle by removing managed entries. Enforcement:
  `tests/unit/mutual-ssh-hardening.test.ts` (ratchet).
