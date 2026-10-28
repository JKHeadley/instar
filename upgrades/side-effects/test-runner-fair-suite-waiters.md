# Side-Effects Review — fair turns for waiting full test suites

**Version / slug:** `test-runner-fair-suite-waiters`
**Date:** `2026-10-28`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (narrow, revert-safe). This fixes Echo Bugs topic 10000001087: urgent live host checks starved behind the single full-suite slot. The 10-26 merge-gate claim made an ordinary suite yield for as long as any live claim existed, and the coordinator re-claims for each next queued entry, so the yield had no bound. Admission was also first-to-poll. Now each blocked suite-lane request writes a short-lease waiter ticket (`~/.instar/host-test-runner-waiters/`), and admission requires `live + waitersAhead < cap`. The order is: an aged ordinary suite (waited 15 min or more), then merge-gate, then ordinary by arrival, with ties broken by start time and then id. An aged ordinary request stops honoring the coordinator claim. Files: `src/core/hostTestRunnerSemaphore.ts` (ticket store, ordering, acquire wiring), `src/server/routes.ts` (`suiteWaiters` field), `tests/setup/test-runner-semaphore.globalSetup.ts` (wait line), `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` + `src/server/CapabilityIndex.ts` (awareness), the spec section, and tests in all three tiers. Size: about 10 files, about 350 LOC including tests. Effort: one design pass, no spec review rounds (pre-authorized §2.6 refinement), one commit attempt so far.

## Decision-point inventory

- `HostTestRunnerSemaphore.acquire` suite-lane admission — **modify** — chooses which waiter takes a free slot; the cap is unchanged.
- Merge-gate claim honoring (`priorityWait`) — **modify** — now bounded by the 15-min aging of the waiting request.
- Targeted lane, dry-run posture, fail-open paths, reclaim — **pass-through** (unchanged).

---

## 1. Over-block

The change can delay a run that previously would have barged in: a newly arriving ordinary suite now waits behind older ticketed waiters, and a merge-gate child waits behind an aged ordinary suite. That is the intended ordering, not over-block. Total admitted throughput is unchanged (the slot is never left idle while a live waiter exists). One idle-slot window exists: a waiter whose process is alive but stuck (not polling) keeps its ticket for at most 60 s (the lease) and could hold others back that long. A SIGSTOPped holder is the same today. Waiting costs no budget beyond the run's own wait ceiling.

## 2. Under-block

Mixed-version hosts: an older checkout ignores tickets and can still barge ahead of a ticketed waiter. This fades as checkouts update; it is no worse than today. A run that times out and retries loses its age (its start time resets). A merge-gate child that times out behind an aged waiter requeues without counting an attempt (existing behavior), and the coordinator may spend preparation work before learning that. That is wasted work, not starvation.

## 3. Level-of-abstraction fit

Right layer: ordering belongs in the same chokepoint that owns the cap and the merge-gate claim. Putting it in Local Verify would only address one caller. The store reuses the claim-store pattern (per-owner files, lease, bounded at 64, liveness-checked reads) and the shared `atomicWriteFileSync` / `SafeFsExecutor` primitives.

## 4. Signal vs authority compliance

The limiter is an existing authority over test admission (operator-ratified). This change gives it no new blocking power: it cannot reduce the number admitted below the cap, and every ticket failure (unwritable dir, corrupt file, full store) falls back to the pre-ticket barging behavior, never to a block. The tie-break order is total, so two waiters cannot deadlock by each yielding to the other.

## 4b. Judgment-point check

The 15-min aging bound is a pinned scheduling constant, not a competing-signals judgment. It is chosen below the 45-min ordinary acquire budget and near one verify's typical hold, so an ordinary run that waited through one verify gets the next slot. No LLM judgment is appropriate inside a sub-millisecond lock path.

## 5. Interactions

- 10-26 merge-gate claim: still honored by ordinary waiters under 15 min, so the preparation race stays closed. Covered by the existing test, which still passes.
- Nested lanes under a verify slot use ancestry skip before `acquire` and never write tickets.
- Dry-run posture: admission always proceeds, tickets are never written, and `waitersAhead` is only ledgered.
- Reclaim and TTL are untouched; tickets are not holders and never count toward the cap.
- Ledger `block` / `would-block` events gain a `waitersAhead` field (additive).

## 6. External surfaces

New additive `suiteWaiters` field on `GET /test-runner-limiter` (pid, priority, waitedMs, aged). New files under `~/.instar/host-test-runner-waiters/` (0600, dir 0700). The wait line printed by test runs now names the waiters ahead. The new `onWaitTick` parameter is additive; existing callbacks ignore it.

## 6b. Operator-surface quality

No dashboard or approval surface touched — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the bound is a per-host CPU/memory guard, so tickets carry the hostname and foreign-host tickets are ignored, as with holders and claims. Nothing replicates, and no user-facing notice is added.

## 8. Rollback cost

A revert is the whole back-out. Leftover ticket files are ignored by the old code and expire on their own; no migration or state repair is needed. The CLAUDE.md line added by the migration would stay on migrated agents as harmless text describing a missing field.

## Conclusion

Ship. The change closes the unbounded-starvation path without touching the cap, isolation, or fail-open behavior, and it falls back to the old behavior on any ticket failure.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect, and no self-triggered controller added (tickets are passive files written by a waiting caller) — not applicable.

## Evidence pointers

- `tests/unit/host-test-runner-semaphore.test.ts` → "suite waiter tickets — fair aging…" (7 tests, including a replay of the 10-28 starvation). With the ordering disabled, three of them fail.
- `tests/integration/test-runner-limiter-route.test.ts` → "lists live suite waiters…".
- `tests/e2e/test-runner-limiter-lifecycle.test.ts` → `suiteWaiters` in the alive shape.
- `tests/unit/PostUpdateMigrator-mergeGatePreparation.test.ts` → idempotent migration.

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent
**Independent read of the artifact: concur**

The reviewer found no deadlock: the ordering is total and aging only moves forward. No slot sits idle while a live waiter could take it, apart from the 60 s lease case for a stuck waiter. Tickets cannot leak or block. Dry-run never writes tickets, and the 10-26 race stays closed. They noted one minor gap: a winner could be counted twice (as both holder and ticket) until its `finally` ran, costing at most one poll at cap >1. That is fixed: the ticket is now cleared under the lock at admission.

## Follow-up commit

The full unit run's No Silent Fallbacks check counted one new unmarked fallback: `listSuiteWaiters` returns `[]` when the waiter directory is missing. That is the intended barging fallback, so it now carries `@silent-fallback-ok`. No behavior change.
