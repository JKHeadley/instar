# Side-Effects Review — Live credential re-pointing (Increment A, Step 5a: swap I/O + journal foundation)

**Version / slug:** `live-credential-repointing-increment-a-swap-foundation`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `not required` (primitives only — no swap logic, no consumer, no live write path; the Step-5b executor that drives them carries the second-pass — see §4)

## Summary of the change

The two crash-safety primitives the Step-5b `CredentialSwapExecutor` will build on, plus their tests. No swap is performed and nothing calls them yet, so this commit changes no runtime behavior and writes no credentials.

- **`src/core/CredentialKeychainIO.ts`** — async, 10s-bounded `security` read/write/delete (spec §2.3: the existing sync `defaultCredentialStore` can wedge the event loop on a locked keychain). The credential blob is written via the `security -i` stdin (hex) form, never as a `-w <blob>` argv argument, so it never appears in the process list. Exposes the **staging namespace** `instar-credential-swap-staging-<swapId>` with `assertStagingDisjoint()` pinning the §2.3.2 invariant that staging can never collide with a `claudeCredentialService` output.
- **`src/core/CredentialSwapJournal.ts`** — the durable in-flight swap record (distinct from the ledger's assignment journal): carries `swapId`, both slots, both pre-swap account ids, and `stagingRef` so a crash mid-swap is decidable. Phases `begin → exchanged → committed → done` (+ `aborted`); a non-terminal phase keeps the swap (and its staging escrow) in the in-flight set per the §2.3.2 sweep predicate ("`begin` AND `committed` both keep staging alive; only `done` orphans it"). Atomic tmp+rename state file; size-rotated `logs/credential-swaps.jsonl` history when a `logsDir` is configured.
- Allowlists `CredentialKeychainIO.ts` in `lint-no-unfunneled-credential-write.js` (it owns the raw keychain write for the slot + staging services; its writes are driven only by the executor inside the funnel) and updates the lint test's closed-allowlist assertion.
- Tests: `credential-swap-journal.test.ts` (8) + `credential-keychain-io.test.ts` (7).

## Decision-point inventory

- None. Both modules are mechanism: bounded I/O and a bookkeeping record. Neither gates agent behavior, filters a message, or blocks an action. No swap decision is made here (that is the Step-5b executor).

---

## 1. Over-block
No block/allow surface. The only "refusal" is `assertStagingDisjoint` throwing if the staging prefix were ever changed to collide with the Claude namespace — a build-invariant guard, not a runtime content decision. Unreachable with the shipped prefixes.

## 2. Under-block
No block/allow surface. The journal cannot mis-classify an in-flight swap: `isTerminalPhase` is total over the phase union and unit-tested on both sides. The keychain I/O returns `null`/`false` on every error (absent entry, missing binary, timeout) — it never throws a surprise.

## 3. Level-of-abstraction fit
Correct layer. A `src/core` async I/O primitive + a durable recovery record — the same layer as `defaultCredentialStore` and `CredentialLocationLedger`. The journal is deliberately SEPARATE from the ledger journal because it carries swap-recovery material (`stagingRef`, pre-swap account ids) the ledger journal does not; conflating them would overload the ledger's assignment bookkeeping.

## 4. Signal vs authority compliance
Compliant — pure mechanism, no authority. Neither module decides anything about agent behavior. **Second-pass review: not required** under Phase 5 (no consumer, no live write path, no messaging/dispatch/session decision — the same basis as Step 4a's funnel primitive). The point where these gain real authority over credential movement is **Step 5b** (the `swap()` executor) and that commit carries the full second-pass review.

## 5. Interactions
- **No consumers yet** — nothing calls the keychain I/O or the journal in this commit, so they cannot race, shadow, or double-fire against any existing path.
- The staging namespace is provably disjoint from every `claudeCredentialService` output (unit-tested over many homes), so a staged blob can never be read by a `claude` client or the QuotaPoller — the §0.d "readable from two config homes" hazard cannot originate from staging.
- The journal's atomic tmp+rename mirrors the ledger/SubscriptionPool persistence pattern; a crash during save leaves the prior file intact.

## 6. External surfaces
None reachable in this commit (no caller). The keychain I/O, once driven by the executor, will touch the macOS keychain on THIS machine only; the journal writes two local files (`state/credential-swaps.json`, `logs/credential-swaps.jsonl`). No routes, no network, no notices, nothing visible to other agents/users.

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN.** Keychain entries and the swap journal are per-machine: a swap moves credentials within ONE machine's keychain, and its recovery record must live beside the keychain it heals. There is no shared state to replicate; a credential move on machine A is independent of machine B's keychain (each has its own login lineage). Cross-machine coordination of a topic move mid-swap is the existing handoff guard's job, wired in a later step — not these primitives'.

## 8. Rollback cost
Near-zero. Two new files + tests + one lint allowlist line; no consumers, no writes, no migration, no persisted state created at runtime (the files are only written once the executor runs). Plain `git revert` leaves no behavior change.
