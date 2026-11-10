# Side-effects review — keyed fenced lease (the per-topic fold lock)

**Version / slug:** `cb-keyed-fold-lease`
**Date:** 2026-11-09
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (Fable 5.2; see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.3 step 1 ("Take the per-topic lock through a keyed fenced lease (`LeaseStore` generalised with a key that is part of the signed `FencedLease` tuple; `local` medium on a single machine; CAS push per step on the `git` medium, measured in Phase 0)"), §9.3 Quarantine ("transfers the keyed lease to the sentinel with a new generation … a handover, not a re-acquire"), §14 "Fold lock" row, §18 ("keyed fenced lease on `local` and `git` media with the key in the signed tuple"). Converged 6 rounds, approved 2026-11-09 17:22 PST. Phase 0, slice 7a; independent of the earlier slices (branches from main).
**Tier:** 2 (new lock primitive inside the machine-lease module; nothing in production uses it yet). Size: 6 files, ~720 LOC incl. ~430 test LOC. Effort: one build pass, two review rounds (one blocking round, fixed), 6 commit attempts (the self-action declaration and its artifact mirror were missing at first).

## Summary of the change

1. **`FencedLease`** gains three additive methods: `canonicalizeKeyed` (a discriminated canonical form `['keyed-lease', key, holder, role, generation, acquiredAt, expiresAt, nonce, released]`), `signKeyedLease`, `verifyKeyedLease`, plus the `KeyedLeaseRecord` type. The machine lease's `canonicalize`, `signLease` and `verifyLease` are untouched (a test pins the legacy canonical form), and the discriminator means a keyed lease can never verify as a machine lease or a hand-back token, nor the reverse.
2. **`src/core/KeyedLease.ts`**: a `KeyedLeaseStore` interface (the spec's "`LeaseStore` generalised with a key", built as a parallel keyed interface with the same CAS discipline rather than a change to the single-lease `LeaseStore`, whose awake/standby lifecycle a fold lock must not touch) with two media sharing one CAS rule (strict advance over a floor, never a force): `LocalKeyedLeaseStore` (one 0600 file per key in a 0700 dir; read-compare-write serialised by an exclusive `<key>.lock` (O_EXCL; a stale lock older than 10 s is broken) so two processes cannot both win; a monotonic `<key>.floor` file written before the lease, so a lost or torn lease file can never let a generation be reused; unbounded or non-integer generations are not a floor) and `GitKeyedLeaseStore` (pull-rebase → re-read → write → commit-and-push per step; a rejected push reverts the local write and returns the observed state). `KeyedLeaseLock` provides `acquire` (refused while any live, verified holder has the key, any role), `handover(held, toRole)` (only for the exact signed record the caller holds, to a new role at the next generation, allowed after expiry: the hung-coordinator quarantine case), `renew(held)` (same generation, compare-and-swap on the exact record), `release(held)` (signed tombstone at the next generation; the floor never drops), `holds(held)` (the fencing check pins the exact signed record, so two hands with the same role and generation can never both pass) and `adopt` (a restarted process re-adopting its own committed record). Every method refuses an unsafe key instead of throwing. `released` verifies only as a signed boolean `true`.
3. **`src/core/foldLeaseFactory.ts`**: production construction, signing with this machine's identity and verifying against paired machines' stored identities exactly as `server.ts` does for the machine lease; default `local` medium at `<stateDir>/state/fold-leases/`; base TTL 10 minutes until Phase 0 measures the p99 fold duration (§9.3).

Nothing constructs the lock in production yet: the FoldCoordinator (next slice, same task) is its only caller. The `git` medium's binding to the agent's real git-sync seams is made where a pool's placement is live, which is when the spec requires the ownership record and a shared lock (§9.3: "on a single-machine agent, and on a multi-machine agent whose session pool is `dark`, the host is the owner by default"). <!-- tracked: CMT-1536 (Phase 0 task 7 FoldCoordinator wiring; git-medium binding when pool placement is live) -->

## Decision-point inventory

- **Added (not yet consulted by anything):** who may hold a topic's fold lock. Deterministic: signature, generation, expiry. No judgment.

## 1. Over-block

- A lock whose holder's identity is not stored on this machine (unpaired) is treated as not held, so a second machine may acquire over it. That is the intended trust rule (same as the machine lease); the e2e test shows it.
- A machine whose own lock expired while it was still working loses it to a peer; `holds()` then fences it out. That is the point of fencing.

## 2. Under-block

- The `local` medium is not a shared substrate: two machines without a shared medium could each hold a lock for the same topic. Bounded by the spec's owner rule (only the topic's owner folds; on a dark pool the host is the owner) and by the git medium where placement is live.
- Expiry uses this machine's clock only to decide whether a *different* holder may take over; authority is the generation and the exact record.
- Git medium in a partition: a holder whose pull fails keeps reading its stale view and passes `holds` until its TTL, with no clock-skew margin for a peer's takeover. The TTL bounds it; the coordinator renews per step, and a renewal over a partition fails its push, which reports the lock lost.
- Git medium on a shared tree: an unrelated peer commit makes a push non-fast-forward, which reads as a lost CAS; the caller retries. A spurious refusal, never a split.
- The git medium's measured cost on this machine (local bare remote): one CAS step ≈ 157 ms. A real remote is slower; the coordinator renews per step, so step bounds must allow it (recorded for Phase 0 task 11).

## 3. Level-of-abstraction fit

Right layer: it reuses the machine lease's signing seam and the store's CAS discipline instead of a new lock primitive, and keeps the per-key lock out of the single-lease `LeaseCoordinator` (whose awake/standby lifecycle a fold lock must not touch).

## 4. Signal vs authority compliance

A lock is an authority primitive, but deterministic and cryptographic (no brittle heuristic), and nothing gates user messages on it. The fold that will consult it is itself fail-closed toward not folding.

## 5. Interactions

- **Machine lease:** no shared files, no shared canonical form, no change to its code paths (21 existing lease test files, 254 tests, re-run green).
- **Git sync:** none yet (the git medium is constructed only by tests in this slice).
- **File Viewer / backup:** `.instar/state/` is git-ignored; lock files hold signatures and ids, no secret material.

## 6. External surfaces

None at runtime. New module exports only.

## 7. Multi-machine posture

`local` medium is machine-local by design (single-machine owner); the `git` medium is the replicated posture for a live pool (§14 "Fold lock: unified … CAS push per step on the git medium"), built and tested here over a real remote, bound to the agent's git seams with the FoldCoordinator.

## 8. Rollback cost

Trivial: revert. No state is written in production.

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: a one-shot lock primitive. `acquire`/`renew`/`release`/`handover` are called by their owner once per fold step; there is no self-triggered loop, timer or retry, and the store lock refuses rather than retries.

## Evidence

- `tests/unit/KeyedLease.test.ts` (16): key/field tampering refused; keyed vs machine lease cross-verification refused and the legacy canonical form unchanged; a forged holder name refused; local medium: generation 1 and 0600/0700, second acquirer refused on any machine or role, keys independent, takeover after expiry fences the old holder (late renewal refused), renewal extends at the same generation, handover after expiry to the sentinel fences the coordinator, handover refused for another machine or generation, release tombstone and floor, forged or replayed file not held and cannot lower the floor, unsafe key refused; git medium with fake seams: push per step, rejected push reverts, rejected renewal reports loss.
- `tests/integration/keyed-lease-git-medium.test.ts` (3): a real bare remote with two clones and real keys: the second machine sees the lock after its pull; a stale-view race loses at push, reverts, then observes the winner; release then acquire at the next generation. Measured acquire step: 157 ms.
- `tests/e2e/fold-lease-production-crypto.test.ts` (4): the production factory on real `MachineIdentityManager` identities: default per-topic file location; a paired machine honours the holder's lock and an unpaired machine's lock is not honoured (the first run, before the peers' identities were stored, failed exactly there: verification is what gates); key replay across topics refused; handover on real keys.

## Second-pass review

**Reviewer (independent subagent on Fable 5.2, 2026-11-09):** "Concern raised." Blocking: (1) `holds` unpinned by tests (removing the role or the generation check failed nothing); (2) two hands could both pass `holds` (it matched role and generation only) and the local CAS was an unlocked read-then-rename, so two processes could both win, and `refresh` could lower the floor; (3) the floor was unverified file content (a torn file read as generation 0, allowing reuse; a forged 1e308 bricked the key). Minor: `released` truthiness; unsigned extra fields could ride along in `signKeyedLease`; `handover` had no caller check; git pull failures ignored; the git seam contract underspecified; spurious `cas-lost` on a shared tree; unsafe keys threw outside `acquire`; an integration-test comment overstated the race; the parallel-interface deviation unflagged.

**Resolution (all in this commit):** fencing now pins the exact signed record (`holds(held)`, `renew(held)`, `release(held)`, `handover(held, role)`), with tests for same-holder wrong-role, wrong-generation and a same-role/generation twin; the local store serialises read-compare-write with an O_EXCL lock file (stale lock broken; test) and keeps a monotonic floor file written before the lease (torn-file and forged-huge-generation tests); `refresh` is CAS on the exact signature; `released` verifies only as signed `true` and generations must be safe integers ≥ 1 (test); `signKeyedLease` carries only signed fields; every method refuses unsafe keys (test); the git seam contract now states `commitAndPush` must drop its own commit on rejection, and the partition and shared-tree behaviours are disclosed in §2; the test comment is corrected; the parallel-interface choice is stated in Summary item 2 and the module header.

**Reviewer re-check (same reviewer, after the fixes):** "Concur with the review." All three blocking items confirmed resolved against the code. New minor notes, addressed in this commit unless stated: a stale-lock break could double-enter with two contenders (now broken by an atomic rename to a unique name, so only one contender breaks it); the busy path threw for up to 10 s after a writer crash and spun the event loop (now it refuses immediately with a lost CAS, never throws or waits; test updated); a forged `Number.MAX_SAFE_INTEGER` generation still bricked a key (generations above 1e12 are now invalid, never a floor; test added); `adopt()` matches role and generation, not a record (documented as single-writer only; the FoldCoordinator is the one hand per topic). Left for the binding slice: the git medium's `<key>.lock` and `.tmp` files sit in the synced directory and must be ignored by the sync, and a holder on a failed pull trusts its stale view until TTL (disclosed in §2). <!-- tracked: CMT-1536 (git-medium binding when pool placement is live) -->
