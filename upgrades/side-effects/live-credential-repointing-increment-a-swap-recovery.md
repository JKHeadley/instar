# Side-Effects Review — Live credential re-pointing (Increment A, Step 5c: boot-recovery sweep)

**Version / slug:** `live-credential-repointing-increment-a-swap-recovery`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `required` (recovery performs destructive credential WRITES from a partial state — the re-drive; result appended below)

## Summary of the change

`CredentialSwapExecutor.recoverInFlight()` (+ `credential-swap-recovery.test.ts`, 6 tests) — the boot-recovery sweep that resolves a swap interrupted by a crash. Ships **DARK** (no caller wires it until the feature is enabled / a later step wires it at server start; it is a NO-OP when the journal has no in-flight swaps).

For each in-flight journal swap, under the single-mover mutex + both per-slot locks (recovery WRITES take the locks, spec §2.3 line 471):
1. Verify both slots against the INTENDED post-swap identity (oracle).
2. **Oracle unavailable for either** → quarantine that slot, retain staging, defer (`deferred-oracle-unavailable`) — never guess.
3. **Both slots already intended** → finish: idempotent `recordAssignment`, delete staging, journal `done` (`completed`) — this is the lost-delayed-re-verify case AND the reviewer-flagged "phase=committed crash".
4. **Both slots still pre-swap** → nothing took: delete staging, journal `aborted` (`aborted-noop`); the ledger already reflects pre-swap.
5. **Genuinely partial** (a crash between the two exchange writes) → `reDriveRecovery`: accountA's blob = the staging escrow; accountB's blob = whichever slot currently identity-verifies as accountB (its CURRENT bytes — adopt-on-newer); write accountB→slotA, accountA→slotB, re-verify; clean → commit + delete staging + `done` (`re-driven`); else quarantine + retain staging.

Addresses both Step-5b second-pass-flagged recovery cases: the partial-commit (`recordAssignment` is idempotent, so re-committing reconciles a crash between the two commit writes) and the UNKNOWN-mode interaction (`recoverInFlight` re-seeds via `seedFromOracle()` first; `commitRecovered` skips the write if the ledger is still corrupt, never throwing).

## Decision-point inventory
- The recovery resolution per swap (completed / aborted / re-driven / deferred / quarantined) — **add** — a deterministic, fail-closed classification of an interrupted swap against on-disk + oracle truth. The dangerous direction (writing a credential it cannot verify) is excluded: a re-drive whose re-verify fails quarantines rather than trusting the write.

---

## 1. Over-block
Recovery quarantines (excludes from balancing) any slot it cannot confirm: an unavailable oracle, an unlocatable escrow/blob, or a re-drive that still fails verification. Quarantine is the conservative action — the alternative (trusting an unverifiable credential) is the corruption this prevents. A quarantine is lifted by the §2.4 re-probe when the oracle returns. No legitimate, verifiable swap is left unresolved.

## 2. Under-block
Recovery cannot silently leave a swap half-done: every in-flight journal row is resolved to a terminal phase (`done`/`aborted`) OR explicitly quarantined-and-retained (staging kept as the heal source) OR deferred `busy` (a live swap holds the locks — retried next sweep). The documented residual: a staging entry whose JOURNAL ROW was lost (a corrupt journal) is not enumerated here — it is harmless (the disjoint namespace is never read by a client) and would need a keychain-enumeration sweep, noted as a future refinement, not a recovery hazard.

## 3. Level-of-abstraction fit
Correct layer — recovery lives on the executor that owns the swap lifecycle, reusing its `verifySlotIdentity` / lock / journal / ledger surfaces. The keychain-backed-oracle test harness exercises the partial-state transitions realistically rather than with a hardcoded verdict.

## 4. Signal vs authority compliance
Compliant. Recovery holds authority over completing/reverting an interrupted move, but every branch is a deterministic response to a concrete observed state (oracle verdict + on-disk blobs). The §2.3.4 invariant is preserved end-to-end: an unavailable oracle NEVER triggers a recovery write — it quarantines and defers. The re-drive only ever writes blobs it located by identity (adopt-on-newer), and re-verifies before committing.

## 5. Interactions
- **Locks:** recovery acquires the SAME single-mover + per-slot locks a live swap/refresh uses, so it can't race them (the Step-5b second-pass fix, applied here from the start). A live swap holding the mover yields `busy` (retry), never a forced action on a stale view.
- **Ledger:** `commitRecovered` is idempotent and unknownMode-guarded. `recoverInFlight` re-seeds a corrupt ledger first.
- **Journal:** drives off `journal.inFlight()`; resolves each to a terminal phase or leaves it for the next sweep. No double-resolution (terminal phases drop out of `inFlight()`).

## 6. External surfaces
While dark / unwired: none. Once wired at boot: the macOS keychain (slot + staging services) on THIS machine, the ledger + swap-journal files, and a HIGH attention item on a quarantine. No network beyond the oracle's read-only probe.

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN.** Recovery heals a per-machine keychain from a per-machine journal; both are machine-local and must be. A swap on machine A and its recovery are independent of machine B. The journal-in-flight slots being excluded from placement/poll/balancing until resolved (a later wiring step) is the cross-machine-safe posture — a half-recovered slot is never handed work.

## 8. Rollback cost
Low while unwired. `git revert` removes the recovery methods + test; no caller, no migration, no persisted state. Once wired, a misbehaving recovery is bounded by the same quarantine-rather-than-guess discipline (worst case: a spurious quarantine, recoverable via the §2.4 re-probe) — it can only write a blob it located by identity and re-verified.

---

## Second-pass review

_Appended by the dedicated independent reviewer subagent (Phase 5), 2026-06-13._

**VERDICT: CONCUR — no real defect found.** The reviewer traced every partial-crash interleaving against the real ledger/funnel/keychain primitives and confirmed:
- **§2.3.4 preserved end-to-end** — no `unavailable`→write path exists; `reDriveRecovery` only sets `blobBLoc` on a confirmed `'ok'` probe, so an oracle outage mid-re-drive → quarantine, no write.
- **Every partial-crash interleaving reaches the correct end state** — no-write crash → `aborted-noop`; `blobB→slotA` only → re-drive to intended + commit; both writes done → `completed` (idempotent re-commit); a client rotation during the crash window → recovery reads pre-swap-by-identity → `aborted-noop`, preserving the client's newer blob (no strand).
- **The unconditional `staging→slotB` write cannot strand a newer accountA** — slotB can only hold accountA if the swap's own `blobA→slotB` write completed, which routes to `completed` (never re-drive); the client can't deposit newer-accountA at slotB because accountA is config-pointed at slotA until the swap completes.
- **commitRecovered partial-commit** is correctly reconciled — the journal advances to `done` only AFTER both `recordAssignment` calls, so a crash between them leaves the swap in-flight and the next boot re-runs `completed` → re-establishes both rows; slots are placement-excluded throughout.
- Idempotency/double-run/`busy` all safe; the entire resolve+write body runs inside `withSingleMover` → `withSlotLocks`; genuinely dark (no caller in `src/`).

Two **minor, non-blocking** observations (no fix required for this dark commit):
1. `seedFromOracle()` in `recoverInFlight` runs (awaited, before the per-swap loop) OUTSIDE the single-mover mutex. No intra-method race; the cross-component balancer race is the recovery-complete barrier's job — **recorded as an Increment-B wiring requirement: the barrier must gate the balancer before the unmutexed `seedFromOracle` runs.**
2. No unit test exercises the v1-vs-v2 stale-refresh-token strand (the harness uses single-version blobs) — but that IS the spec-acknowledged §2.3.1a residual that identity-verify provably cannot catch, so a unit test couldn't assert a non-strand; it is the §2.4 audit's job (a later step).

The reviewer found the author's review accurate on every claim checked, including both Step-5b-flagged cases (idempotent re-commit; UNKNOWN-mode re-seed + `commitRecovered` skip-on-corrupt).
