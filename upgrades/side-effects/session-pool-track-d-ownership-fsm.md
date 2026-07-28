# Side-Effects Review — Session Pool Track D(1): SessionOwnership FSM (L3)

**Spec:** docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md §L3 (approved). **Track:** D part 1 (the per-session ownership state machine — pure core). Ships DARK (no CAS store/registry wired yet).
**Files:** src/core/SessionOwnership.ts (new)

## What changed
- **`SessionOwnership.ts` (new, pure):** the §L3 ownership correctness core — no I/O.
  - `SessionOwnershipRecord` ({sessionKey, ownerMachineId, ownershipEpoch, status: placing|active|transferring|released, transferTo?, nonce, timestamp, updatedAt, signature?}).
  - `applyOwnershipAction(current, action, ctx)` — the pure transition: place (only null/released → no stealing a live session), claim (placing→active by the placed-owner, OR transferring→active by the named target — out-of-sequence/wrong-machine rejected), transfer (active→transferring), release (owner→released). Every transition advances the epoch by +1 (the CAS candidate).
  - `mayRun(record, machineId, epoch)` — the run-fence: a worker runs ONLY while it observes itself `active` owner at the current epoch (no double-run; stale epoch grants nothing).
  - `mayEmit(record, machineId, {now, transferringStartedAt, cutoffMs})` — the output-exclusion contract: the draining source emits tail-only within the cutoff window then nothing; the target holds until the cutoff elapses (disjoint windows); the steady-state active owner emits freely.
  - `ownershipNonceKey(sessionKey, sender, epoch, nonce)` — per-session-scoped nonce key (the same nonce in two sessions does not collide; replay within a session is caught).

## Blast radius
- **None at runtime yet.** Nothing imports SessionOwnership — it ships dark, exercised only by its unit tests. The CAS store (per-session git single-ref fast-forward push, reusing the §L−1/GitLeaseStore discipline), the distributed registry, and the MeshRpc claim/release handlers (which wire `ownerOf`/`placementTargetOf` into the dispatcher) land in part 2. Pure additive module.

## Risk + mitigation
- **Risk:** a transition hole that allows two active owners or a no-owner gap (the core §L3 invariant). **Mitigation:** the FSM is pure + tested through the full transfer sequence (active(S)→transferring→active(T)): asserted no state has two active owners at the top epoch and `transferring` always still names S as the draining owner (no gap); out-of-sequence claim (T before transferring) → `claim-out-of-sequence`; wrong-machine claim → `claim-wrong-machine`; place won't steal a live session. 11 tests.
- **Risk:** interleaved/double user output during the S→T overlap. **Mitigation:** the output-exclusion is a separate fence from the run-fence, tested (source tail-only-within-cutoff, target-holds-until-cutoff, disjoint windows).

## Migration parity
- None in part 1 (pure module, unwired, no config). The CAS retry/backoff + clock-tolerance config knobs land with the store (part 2) via the `multiMachine.sessionPool` ConfigDefaults path.

## Rollback
- Additive + dark + unwired. Delete SessionOwnership.ts to revert.

## Tests
- tests/unit/SessionOwnership.test.ts (11): place→claim→active; place-won't-steal-live; the transfer sequence (one-owner-throughout, claim-before-release); out-of-sequence + wrong-machine claim rejected; transfer-requires-active; release-requires-owner; run-fence (no two active owners, stale epoch fenced); output-exclusion (source tail-only, target holds, steady-state free); per-session nonce isolation. tsc clean.

## Agent awareness
- Internal ownership layer; session-pool agent awareness covered by Track B's CLAUDE.md blurb. <!-- tracked: session-pool-track-d -->
