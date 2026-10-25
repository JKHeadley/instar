# Side-Effects Review — Machine Self-Assertion

Spec: `docs/specs/machine-self-assertion.md` (operator-approved 2026-08-30,
Telegram topic 62395). This is a trust-anchor mutation feature, so it receives
the highest review posture even though it ships fleet-dark and dry-run-first.

## Decision-point inventory

1. **Should a peer identity change be accepted?** Authority: the deterministic
   `IdentityReannounceService` composite followed by `IdentityStore`; signals
   include typed refusals, recovery proof, direct-source evidence, peer
   agreement, and governor admission. Ambiguity quarantines; no detector writes.
2. **Should a recovery root be established/replaced?** First establishment is
   pairing-code authority only. Replacement is a separate operator-only
   mutation with its own exact epoch; a signing rotation can never replace it.
3. **Should an observed address become dialable?** Address observations are
   telemetry only in this release. CGNAT/RFC1918 shape is not node identity, so
   the production wiring always marks them non-authoritative; promotion waits
   for a cryptographic machine↔Tailscale-node binding.
4. **Should a quarantined claim proceed?** Only a recent dashboard-PIN operator
   session bound to the exact canonical claim hash. Bearer authority is refused.
5. **Should a retry fire?** The durable claimant episode plus the registered
   `identity-reannounce` SelfActionGovernor class decides; a denial consumes no
   attempt and no network call.

## Over-accept analysis

- A bearer holder cannot enroll a new machine, establish the first recovery
  root, clear revocation, or approve quarantine. With a recovery root present,
  the claimant must sign a nonce/identity/epoch/key-fingerprint continuity
  binding using the separately escrowed private key.
- Machine-auth alone cannot propagate operator decisions. Remote recovery-root
  rotations and acknowledgements require a nonce/recipient/action/subject/
  epoch/content/expiry-bound grant signed by an already-pinned recovery root.
  First root establishment has no such prior root and therefore remains inside
  the single-use pairing-code ceremony; an older peer must re-pair.
- Recovery-bearer bootstrap and periodic bulk projections bind a fresh caller
  nonce, exact responder/recipient, and ciphertext/view hash under the expected
  peer signing key. Substitution and replay do not update runtime or config.
- New-key possession is independently proven with the replacement signing key.
  Challenges are random, one-use, 60-second, and burned before authority checks.
- Exact stored+1 epochs and signing/recovery tombstones prevent rollback, skip,
  and reuse. Signing and recovery changes are structurally separate.
- A first-hand pairing anchor is distinguished from a replicated copy. Replicated
  roots need matching live-peer evidence; equal-epoch conflicts quarantine.
- Revocation is committed to the independent epoch authority before the registry
  UI row, so interruption can only fail closed. Only fresh pairing trust can
  deliberately clear it.
- File Viewer/API and state-sync classification share a static protected-path
  manifest. Identity/evidence authority cannot be read, edited, or merged via
  the bearer file surface; symlink resolution re-checks the resolved path.

## Under-accept / availability analysis

- A machine without a genuinely keychain-backed SecretStore never claims escrow
  protection. Because address-only incumbent provenance is fail-closed in this
  release, it waits for PIN review; no file-key fallback is described as secure escrow.
- Missing/dark peers contribute no agreement. They never fabricate consensus.
  A first-hand anchor still permits the designed two-machine recovery case.
- A prior weak accepted rotation remains visible and suspends further weak
  recovery until acknowledged. Valid first-hand continuity may still heal.
- Route absence on older peers is classified as `route-absent` and retried on
  the same bounded ladder. Transient/refused outcomes back off through
  1m→5m→30m→6h and stop at the 72h horizon.
- Dry-run returns would-verdicts and is byte-identical for identity and escrow
  storage; it never mints a recovery key merely to predict an outcome.

## Information disclosure

- HTTP refusals name protocol categories, not stored epoch values, public-key
  material, addresses, or peer inventories. The dashboard shows fingerprints/
  machine identifiers only as review support, never secret keys.
- In-memory endpoint observations normalize private IP plus configured server
  port; they are non-authoritative and dry-run shared-egress retraction does not
  touch the durable registry.
- Recovery private keys and the sealed public identity snapshot stay inside the
  existing encrypted SecretStore, outside `.instar/machine/**`; no API returns
  either private material or ciphertext.

## Denial-of-service and self-action bounds

- Challenge budgets: three per machine and twelve per source per 24 hours.
- Automatic initiation: ten consecutive typed failures spanning at least 15
  minutes; any verified success resets the run.
- Per-peer episode: widening backoff capped at one attempt per six hours, 72-hour horizon,
  one first-acceptance notice, outcome updates only on transitions, one HIGH at
  exhaustion. The governor adds a one-per-peer/day floor and a pool ceiling.
- Endpoint evidence is LRU-bounded to eight rows per peer, TTL-pruned, and
  discarded/suspended after rotation. Signed dial-back has a 10-second timeout.

## Multi-machine coherence

- Identity authority is machine-local but agreement-aware. Each receiver owns
  its stored peer key/epochs and queries allowed live peers' current promoted
  identity projections before accepting replicated-anchor evidence. Divergence quarantines locally.
- `/identity-changes?scope=pool` classifies dark/rejected peers instead of
  presenting a silently local result. Credential-bearing peer fetches pass the
  existing URL allowlist gate.
- Observed endpoints are local evidence by design and are never git/state-sync
  authority. Accepted identity changes suspend their evidence for one hour.
- Version/flag coherence remains the pool guard during mixed rollout; old peers
  return route-absent and never trigger a legacy blind write.
- Live mutation stays held until authenticated presence supplies fresh exact-mode
  adverts for every active peer. The recurring presence tick refreshes that proof,
  adopts peer-set changes, and can activate later without a server restart.

## Operator-surface quality

- The Machines card leads with plain availability/root status, then only rows
  needing review. It uses `textContent` for peer-controlled fields and stacks
  controls at phone width.
- Approve/deny first mint a single-use two-minute token bound to the exact
  quarantine id + canonical claim hash under the PIN-unlocked operator session.
  A generic bearer or swapped claim cannot act.
- Destructive denial is visually peer-level, not promoted as the primary action;
  every action refreshes authoritative state and keeps failures visible inline.

## Migration and rollback

- `ConfigDefaults` adds only missing `dryRun:true` blocks and intentionally omits
  `enabled`, so development-agent gating remains live-on-dev/dark-fleet. Existing
  operator overrides and siblings are preserved; migration is idempotently tested.
- Generated CLAUDE.md, deployed CLAUDE.md migration, framework shadows, and the
  capability registry all carry Registry First/proactive awareness.
- First rollback: explicitly disable the three feature flags. Old builds ignore
  optional identity fields and additive authority files. Rollback never lowers an
  epoch, deletes tombstones, clears revocation, or destroys a recovery key.
- De-pair/leave deliberately destroys the local recovery escrow after sticky
  revocation. Ordinary rollback does not.

## Remaining risk

- Revocation writes the sticky epoch plus current signing/recovery tombstones in
  one atomic authority file before its registry row. Identity rotations use a
  replayable transaction journal with staged/rollback-safe private keys.
- OS keychain availability can change after boot. Status reports live escrow
  availability; an unavailable key degrades to quarantine instead of bypass.
- Pool agreement is bounded by reachable upgraded peers and their current
  promoted projections. A missing projection is unverifiable, not agreement; a
  conflict is divergence.

## Signal vs authority and judgment-point review

Required reference: `docs/signal-vs-authority.md`.

This change does hold blocking authority, but only over an irreversible
trust-anchor mutation whose inputs and safe outcomes are explicitly enumerable.
Typed-refusal counters, endpoint observations, peer projections, and recovery
proofs remain signals. The single `IdentityReannounceService` composite is the
authority: it accepts only when every invariant is satisfied, quarantines every
ambiguous combination for a PIN-bound operator decision, and never promotes an
address observation by itself. This is the safety-guard exception described in
the principle, not a brittle semantic judgment or a competing-signals heuristic.

## Interactions and external surfaces

The claimant, divergence monitor, presence reconciler, activation gate, and
SelfActionGovernor share one durable episode instead of independently firing.
Attempt state is committed before network I/O, restart reconciliation consumes
the same journal, and transition-only notices prevent double-fire. The external
surfaces are additive authenticated routes, one dashboard card, protected local
authority files, signed peer traffic, and a one-voice operator notice. No secret
or raw technical input is exposed to the operator.

## Class-Closure Declaration

- `defectClass`: `unbounded-self-action`
- `closure`: `guard`
- `guardEvidence.enforcementType`: `ratchet`
- `guardEvidence.citation`: `tests/unit/self-action-convergence.test.ts`
- `guardEvidence.howCaught`: The registered identity-reannounce control loop has
  a one-per-peer/day governor floor, pool ceiling, persisted attempt-before-I/O,
  widening 1m→5m→30m→6h backoff, 72-hour horizon, transition-only notices, and
  an exhaustion terminal state. The convergence ratchet rejects removal of the
  steady-state bound or settling brake.

## Second-pass review and conclusion

The independent security and test-review passes concurred with the review. The
review tightened recovery-root propagation, boot ordering, replay boundaries,
peer-agreement semantics, retry persistence, and the operator surface before the
build was considered complete. With the feature fleet-dark, development-only,
and dry-run-first, the change is clear to ship for CI validation.
