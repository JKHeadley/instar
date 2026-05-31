# Side-Effects Review — Router confirms remote placement (bug #11)

**Version / slug:** `router-confirm-claim-on-place`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`SessionRouter` gains an optional `confirmClaim(sessionKey, machineId)` dep, called in
`placeAndClaim` right after a successful `spawnOnMachine` on a REMOTE target. `server.ts`
wires it to `ownReg.cas({ type: 'claim', machineId }, …)`, advancing the ownership
record `placing → active`. Without it the record stayed `placing` and every later
message for the session queued (bug #11).

## Decision-point inventory

- **remote branch only** — `confirmClaim` is called only in `placeAndClaim`'s
  remote-spawn path (after `spawnOnMachine`). Self-placement returns handled-locally
  and never confirms. Both covered by tests.
- **FSM gate** — `claim` is permitted only when the record's `ownerMachineId` equals the
  claimed `machineId` (the placed owner). Covered in `SessionOwnership.test.ts`.

## 1. Over-block

**What legitimate inputs does this reject?** Nothing. It only ADDS a confirm after a
remote placement. Self-placement, forwarding to an existing owner, owner-dead
re-placement, and queue paths are unchanged. A `confirmClaim` that fails (e.g. CAS
contention) is best-effort and leaves the placement to recover via the normal fences.

## 2. Under-block

**What does this still miss?** It does not make ownership durable across restarts (the
store is per-machine in-memory — the shared Track-H store is separate). It confirms
optimistically once the spawn is DISPATCHED (the deliverMessage/spawn RPC resolved); if
the target's session later dies, the existing owner-dead detection re-places it. It does
not address bug #7 (standby outbound mute).

## 3. Level-of-abstraction fit

**Right layer?** Yes. The confirm lives in `SessionRouter.placeAndClaim` — the exact
place that owns the place→spawn lifecycle and already does the `place` CAS. The dep is
injected (testable, same pattern as `casClaimOwnership`/`spawnOnMachine`). The FSM
transition itself stays in `SessionOwnership.ts`.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

This advances an ownership record through its designed FSM (`place → claim`), gated by
the FSM's own legal-transition check (claim machineId must equal the placed owner). It
adds no user-facing authority and blocks nothing. It RELAXES nothing about who may own a
session — it completes a transition that was already supposed to happen.

## 5. Interactions

Consumes the existing `ownReg` CAS (the same registry `place`/`transfer`/`release` use).
Pairs with `placeAndClaim`'s `place` CAS (the two halves of a new-session handoff). After
the confirm, `dispatchOne` sees `active` (not `placing`) and forwards subsequent messages
to the owner instead of queueing. Idempotent at the FSM level (a duplicate claim on an
already-active record is rejected `claim-out-of-sequence`, harmless). No interaction with
the lease or the shared-state read-only guard.

## 6. External surfaces

None. No HTTP routes, config, or notifications. The visible effect is a moved session's
ownership reaching `active` (so `/pool` + routing reflect the new owner).

## 7. Rollback cost

Low. Remove the `confirmClaim` dep + call + wiring; transfers revert to stuck-`placing`
(bug #11). No schema, no persisted state, no migration (the dep is optional + in-memory).

## Conclusion

Minimal, FSM-gated completion of a handoff transition that was missing, scoped to the
remote-placement branch, both branches + the FSM transition unit-tested, no new
authority, no external surface, cheap revert. Makes the live single-router transfer's
ownership finalize instead of sticking. Durable cross-machine ownership (Track-H) and
the reply relay (#7) remain separate.

## Second-pass review (if required)

Not required — completes an existing FSM transition via its own legality gate, remote-
branch-only, both sides tested, no shared-state authority changed, reversible. The live
two-machine re-test (fresh topic) is the Tier-3 gate that follows.

## Evidence pointers

- `tests/unit/SessionRouter.test.ts` — remote placement calls `confirmClaim('s1','m_remote')`;
  self-placement does not.
- `tests/unit/SessionOwnership.test.ts` — `place(placing) → claim(active)` transition.
- 47 SessionRouter + ownership + wiring tests green; `tsc --noEmit` clean.
- Found live: `route … action=queued owner=?` on every post-move message; the ownership
  FSM requires place→claim→active and the claim was never issued.
- Spec: `docs/specs/router-confirm-claim-on-place.md` (+ `.eli16.md`).
