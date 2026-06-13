# Side-Effects Review — Live credential re-pointing (Increment A, Step 4a: CredentialWriteFunnel primitive)

**Version / slug:** `live-credential-repointing-increment-a-funnel-primitive`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `not required` (pure in-process lock primitive, no consumers, no writes — see §4)

## Summary of the change

Adds `src/core/CredentialWriteFunnel.ts` (spec §2.2 "Concurrency model" / "Bounded under the lock") — the in-process serialization primitive for credential writes: `withSlotLock(slot, fn)` (per-slot lock), `withSlotLocks(slots, fn)` (canonical-ordered multi-slot, deadlock-free), and `withSingleMover(fn)` (machine-local single-mover mutex for swaps). Acquisition is try-lock-WITH-TIMEOUT — a slow holder degrades to a SKIPPED result with a named reason, never a wedged slot. Plus `tests/unit/credential-write-funnel.test.ts` (8 tests).

This is Step 4a: the PRIMITIVE only. It is **not yet wired** to any writer and the forbidding lint is **not yet added** — that is Step 4b (the lint can't land until every existing writer is routed through the funnel, or it breaks the build). So this commit changes no runtime behavior and writes no credentials.

## Decision-point inventory

- `CredentialWriteFunnel.withSlotLock` / `withSlotLocks` / `withSingleMover` — **add** — serialize concurrent credential writes; on contention they SKIP (bounded), they never block indefinitely. No authority over agent behavior; pure concurrency control with no consumers yet.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The only "refusal" is a try-lock timeout / single-mover-busy SKIP, which is the bounded-wait safety contract (§2.2): a write that can't get the lock in time is reported skipped so the caller degrades gracefully (e.g. the QuotaPoller refresh returns NO-SNAPSHOT) rather than wedging the slot. There are no consumers yet, so nothing is actually skipped in this commit.

---

## 2. Under-block

**No block/allow surface — under-block not applicable.** The funnel cannot serialize a writer that does not route through it — that is precisely what the Step-4b lint exists to prevent, and is called out as the next commit. Within this primitive, the timeout/no-deadlock-after-skip and throw-releases-lock paths are unit-tested.

---

## 3. Level-of-abstraction fit

Correct layer. A `src/core` concurrency primitive, self-contained (the existing `withLock` helpers are cross-PROCESS file locks; this is the IN-process per-slot serialization the spec calls for). It mirrors the SafeGitExecutor / SafeFsExecutor single-funnel precedent the spec names. It bounds only ACQUISITION; the caller bounds its own inner `await` (e.g. a refresh fetch carries its own `AbortSignal.timeout`) — documented in the module header.

---

## 4. Signal vs authority compliance

Compliant — it is mechanism, not authority. It holds no policy and gates no agent behavior; it serializes writes and reports contention as a bounded skip. It cannot become a "brittle check with blocking authority" because it makes no allow/deny decision about content — only about lock availability, with a deterministic bounded outcome. **Second-pass review: not required** under Phase 5 — no consumers, no writes, no messaging/dispatch/session decision. The point where the funnel gains real authority over credential writes is **Step 4b** (routing the four writers + the forbidding lint) and **Step 5** (the swap executor) — both will carry the second-pass review.

---

## 5. Interactions

- **No consumers yet** — nothing calls the funnel in this commit, so it cannot race, shadow, or double-fire against any existing path. Routing the four in-process writers (swap executor, QuotaPoller 401-refresh, OAuthRefresher/EnrollmentWizard, KeychainCredentialProvider.writeCredentials) is Step 4b.
- **All state in-memory** — a process restart clears any crash-stale lock/mutex state by construction (the spec's stated recovery for the single-mover).
- Lock order is documented (single-mover → slot locks ordered by path → ledger write) and `withSlotLocks` enforces the canonical order so two multi-slot ops can't deadlock on opposite orders (unit-tested).

---

## 6. External surfaces

None. No routes, no notices, no network, no filesystem, no keychain. Pure in-process promise/timer machinery. Nothing visible to other agents/users/systems.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN** — credential writes happen against THIS machine's keychain, so the serialization that protects them is inherently per-process/per-machine. The single-mover mutex is explicitly "machine-local" (spec §2.2): it serializes swaps within one machine; cross-machine coordination of a topic move is the existing handoff guard's job (composed-with in Step 5), not this lock's. There is no shared state to replicate.

---

## 8. Rollback cost

Near-zero. New file + new test only; no consumers, no writes, no migration. Plain `git revert`. Because nothing uses the funnel yet, a revert leaves no behavior change.
