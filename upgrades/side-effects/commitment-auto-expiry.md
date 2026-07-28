# Side-Effects Review — Commitment auto-expiry

**Version / slug:** `commitment-auto-expiry`
**Date:** `2026-07-10`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change adds a bounded auto-expiry sweep to `src/monitoring/CommitmentTracker.ts`, configures it through top-level `commitments.autoExpiry`, and wires the server construction path to pass that config into the tracker. The sweep targets stale agent-owned open commitments only, uses the existing `expired` terminal state, preserves user-owned commitments, respects future hard deadlines, ships dry-run-first, and coalesces all per-commitment persistence into one store write per sweep. Tests cover unit, integration, and e2e paths.

## Decision-point inventory

- `CommitmentTracker.sweepAutoExpiry` — add — decides whether a commitment is eligible for terminal expiry based on owner, status, age, and future hard deadline.
- `CommitmentTracker.expire` / `expireSync` — add/modify — centralizes the existing expired-state transition so old `expiresAt` expiry and new auto-expiry use one terminal transition helper.
- `ConfigDefaults.commitments.autoExpiry` — add — defaults the sweep on, 21-day age, 6-hour cadence, dry-run true.

---

## 1. Over-block

The only possible over-close shape is an old agent-owned open commitment that is still genuinely active but has no hard future deadline recorded. This is why the feature ships with `dryRun: true`: the first rollout logs aggregate eligibility without changing rows. The hard guardrails are also narrow: owner must be exactly `agent`, status must be open (`pending` or `violated`), age must exceed the configured threshold, and a future `hardDeadlineAt` blocks expiry.

User-owned commitments are never eligible. Young commitments are never eligible. Terminal commitments are never eligible.

---

## 2. Under-block

The sweep intentionally misses stale commitments that are marked `verified`, because `verified` is treated as a non-open status for this cleanup even though some old stores may still show it in active-ish views. It also misses old user-owned commitments, old rows with malformed `createdAt`, and old rows with a future hard deadline even if that deadline is probably obsolete. Those are deliberate safety choices for the first rollout.

---

## 3. Level-of-abstraction fit

Correct layer. `CommitmentTracker` owns the lifecycle state, terminal status semantics, persistence batching, and active-record filtering. Putting the cleanup in an external job would either duplicate those invariants or risk writing the store by hand. The sweep is a mechanical lifecycle policy, not an LLM judgment; it uses explicit structured fields only.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The sweep does hold lifecycle authority over a narrow state transition, but it does not block a user, tool, message, or operation. It converts stale structured records to the existing terminal `expired` state. The first release runs in dry-run mode, and the live transition requires an operator config flip.

---

## 5. Interactions

- **Existing `expiresAt` expiry:** still runs inside `verify()` and now routes through `expireSync`, preserving behavior while centralizing the terminal transition.
- **Write coalescing:** auto-expiry uses the same `batchingSaves` / `pendingSave` pattern documented for the verify sweep. A test asserts twelve expirations produce exactly one commitments-store write.
- **PromiseBeacon and active views:** expired commitments are terminal; existing active filters already exclude `expired`, so no new filtering contract is needed.
- **Startup timing:** an initial sweep is scheduled shortly after tracker start, then every configured interval. `stop()` clears both the initial timeout and recurring interval.
- **Dry-run logs:** the sweep emits one aggregate log line per pass. It does not log per commitment.

---

## 6. External surfaces

- **Config:** new top-level `commitments.autoExpiry` block: `enabled`, `maxAgeDays`, `sweepIntervalMs`, `dryRun`.
- **Persistent state:** when `dryRun:false`, eligible commitments move to `status:"expired"` with resolution `auto-expired: aged out >Nd, presumed completed-but-unclosed`.
- **API reads:** active commitment API views shrink after expiry because they already exclude terminal expired rows. Individual records remain inspectable.
- **Operator surface:** no new operator action or dashboard form. Operators can tune the config through the existing config path.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated when commitments replication is enabled, otherwise local to the agent store.** The sweep mutates the canonical commitments store through the tracker transition path, so the existing Commitments Coherence replication machinery sees the same terminal-state mutation as any other commitment lifecycle change. It emits no user-facing notices, generates no URLs, and holds no machine-specific runtime state beyond timer handles. If multiple machines run the same agent with replicated commitments, the first machine to expire a row moves it terminal and later sweeps see it as ineligible, making the operation idempotent.

---

## 8. Rollback cost

Low. The shipped default is dry-run, so rollback before promotion is a code/config revert with no data repair. After a future `dryRun:false` promotion, rollback stops future expiry but does not reopen already-expired commitments; that is acceptable because the transition is intentionally terminal and inspectable. If an operator needs to reverse a specific row, they can use existing commitment mutation tools rather than a schema migration.

---

## Conclusion

The change directly addresses commitment backlog rot while preserving the safety floor: dry-run-first rollout, strict owner/age/deadline eligibility, one aggregate log line, bounded 500-row passes, and exactly one store write per sweep. No material side-effect concern remains for the initial dry-run release.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required for this Tier-1 dry-run-first lifecycle cleanup.

---

## Evidence pointers

- `npx tsc --noEmit`
- `npx vitest run tests/unit/CommitmentTracker-auto-expiry.test.ts tests/integration/commitment-auto-expiry-lifecycle.test.ts tests/e2e/commitment-auto-expiry-api-lifecycle.test.ts`
- `npx vitest run tests/unit/CommitmentTracker.test.ts tests/unit/CommitmentTracker-verify-batches-saves.test.ts tests/unit/ConfigDefaults.test.ts`

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The new self-triggered loop has an explicit convergence bound: disabled by config, dry-run by default, one initial timeout plus one recurring interval, max 500 state transitions per pass, one aggregate log line, no per-item user-facing output, and one coalesced persistence write per sweep. Guard evidence: `tests/unit/CommitmentTracker-auto-expiry.test.ts` covers dry-run zero mutation, idempotent second sweep, and one-write batching.
