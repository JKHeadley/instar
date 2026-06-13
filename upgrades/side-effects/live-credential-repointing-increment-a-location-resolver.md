# Side-Effects Review — Live credential re-pointing (Increment A, Step 6a: CredentialLocationResolver)

**Version / slug:** `live-credential-repointing-increment-a-location-resolver`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `not required` (a pure read-side resolver — no consumers yet, no writes, NO-OP while dark; the census-site re-routing that consumes it lands next)

## Summary of the change

`src/core/CredentialLocationResolver.ts` (+ `credential-location-resolver.test.ts`, 7 tests) — the single read-side chokepoint the ~12 spec-§2.2 census consumers will route through to answer "which slot does this account's credential currently live in?". `slotForAccount(accountId, enrollmentHome)` and `tenantForSlot(slot)`; `active()` gates whether the ledger is the authority. Ships **dark** with no consumer yet → zero runtime behavior change.

The load-bearing property: **NO-OP WHILE DARK.** `active()` is false unless the feature is enabled AND the ledger is seeded AND not in UNKNOWN mode. With the shipped `enabled:false`, every method returns exactly today's behavior (the enrollment home / a null tenant the caller already handles). So re-routing a consumer through it is provably a no-op until the deliberate two-flag flip — and even then returns today's answer until a real swap has re-pointed something.

## Decision-point inventory
- `active()` — **add** — the one gate deciding ledger-vs-enrollment-home. Fail-closed for reads: dark / unseeded / corrupt → today's behavior, never a guess.

---

## 1. Over-block / ## 2. Under-block
No block/allow surface — a location resolver, not a gate. It cannot over- or under-block; the only "decision" is which source of truth to read, defaulting to today's source when the ledger isn't authoritative.

## 3. Level-of-abstraction fit
Correct layer. A thin `src/core` read-adapter over the ledger that centralizes the "is the feature active?" branch so the 12 consumers don't each re-implement it (Structure beats Willpower). Reads the live config each call so a flip is honored without reconstructing it.

## 4. Signal vs authority compliance
Compliant — pure read mechanism, no authority over agent behavior. **Second-pass: not required** (no consumer, no write, no messaging/dispatch/session decision). The re-routing commits that consume it are individually reviewed.

## 5. Interactions
No consumers yet → cannot race/shadow/double-fire. Sync reads (never disk/parse), never throws — safe to drop onto the spawn hot path in the follow-up.

## 6. External surfaces
None — no routes, network, files, or notices.

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN** — it reads the per-machine ledger about per-machine credential locations. No shared state.

## 8. Rollback cost
Near-zero — one new file + tests, no consumer, no migration. Plain `git revert`.
