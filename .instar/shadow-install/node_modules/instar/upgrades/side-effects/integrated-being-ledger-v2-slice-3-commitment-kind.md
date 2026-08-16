# Side-Effects Review — Integrated-Being Ledger v2, Slice 3 (Commitment kind)

**Version / slug:** `integrated-being-ledger-v2-slice-3-commitment-kind`
**Date:** `2026-04-17`
**Author:** Echo
**Second-pass reviewer:** required — slice touches idempotency, auth-adjacent rate limits, and a new writable entry kind.

## Summary

Slice 3 lifts the 501 gate from slice 1 and opens the `commitment` write path. Sessions can now declare commitments with mechanism (type, ref), deadline (60s..90d sanity range, mandatory for passive-wait), and a server-bound status of `open`. Two per-session rate caps land here: openCommitmentsPerSession and passiveWaitCommitmentsPerSession, plus sessionWriteRatePerMinute. Dedup-index refinements (NFKC + confusables) and cross-agent ceiling stay in slice 5. Ships behind `v2Enabled=false`.

Files touched:

- `src/server/routes.ts` — commitment-kind validation + rate checks inline in `/shared-state/append`; forbidden-field list now kind-aware.
- `src/core/LedgerSessionRegistry.ts` — new write-rate sliding-window counter, open-commitment + passive-wait counters (in-memory).
- `src/core/SharedStateLedger.ts` — entry serialization extended to pass `commitment` and `disputes` fields (v1 subsystem emitters unchanged).
- `tests/unit/sharedStateRoutesV2.test.ts` — commitment kind happy+edge paths (8), rate-limit tests (2).

## Decision-point inventory

| Decision point | Change | Description |
|---|---|---|
| `commitment.mechanism.type` enum gate | **add** | Structural enum match. Carved-out. |
| `commitment.mechanism.ref` charset gate | **add** | `[a-zA-Z0-9\-_.:]`, max 200. Structural. |
| `commitment.deadline` ISO + 60s..90d sanity | **add** | Structural. Prevents past-dated-narrative spoofing (adversarial A5). |
| `openCommitmentsPerSession` rate cap | **add** | In-memory counter, soft limit. Transport-layer mechanics. |
| `passiveWaitCommitmentsPerSession` rate cap | **add** | Same. |
| `sessionWriteRatePerMinute` sliding window | **add** | In-memory 60s window. Transport-layer mechanics. |
| Forbidden-field list kind-aware | **modify** | `commitment` now allowed iff `kind === 'commitment'`. Pure boolean. |

All new decision points are structural/mechanics — no judgment.

---

## 1. Over-block

- A session supplying `commitment.status: 'open'` (redundant — server sets it) gets a 400. Strict per the spec's status-authority clarification. Acceptable.
- Clock skew at the deadline boundary (exactly now + 60s) could reject. Acceptable — caller retries with a slightly-later deadline.
- `openCommitmentsPerSession` is an in-memory counter — if a commitment is resolved via slice 4's resolve endpoint (not yet shipped), it currently can't decrement the counter. In slice 3 the counter only increments, so in practice a long-running session could hit the cap with legitimate-but-resolved commitments. Mitigation: slice 4 wires the decrement path. Meanwhile, the default cap of 20 is forgiving enough that slice-3-alone agents won't notice.

## 2. Under-block

- Real mechanism-ref verification (lookup against scheduler/sentinel/callback registries) is deferred to slice 5. Slice 3 sets `refStatus: 'unverified'` for every commitment regardless of ref. Acceptable for the observation window — `v2Enabled=false` is still default; no one depends on refStatus accuracy yet.
- Near-duplicate hash index (NFKC + Unicode confusables) deferred to slice 5. Existing v1 dedupKey-based dedup still applies.
- Trust-tier discrepancy emission deferred to slice 5 — `trustTier` is hardcoded `'untrusted'` for session writes. Conservative default; no regression.
- Per-agent-global rate ceiling deferred to slice 5.

## 3. Level-of-abstraction fit

Commitment validation lives inline in the append handler alongside the rest of schema validation — consistent with how counterparty/dedupKey/subject are validated. A separate `MechanismRefValidator` class isn't warranted yet (slice 5's real verification will justify it). The rate counters live on the registry because the registry already owns per-session state (binding tokens, hook-in-progress flags); adding a sibling `RateTracker` class would duplicate the session-id key space.

## 4. Signal vs authority compliance

- [x] No — all new blockers are carved-out structural/mechanics: enum match, charset regex, numeric bounds, counter comparisons. None make judgment calls about what a commitment means. Per signal-vs-authority doc §"When this principle does NOT apply": idempotency keys and dedup at transport layer are explicitly carved out; hard-invariant validators at API boundary are allowed brittle blockers.

## 5. Interactions

- **Shadowing:** the kind-aware forbidden-field list means `commitment` now depends on `kind` being parsed first. Ordering: kind extraction happens BEFORE the forbidden loop — verified in code. No shadow.
- **Double-fire:** commitment's open-counter increment fires after successful append. If append fails (lock contention, dedup-hit), the counter is NOT incremented — verified by code path ordering (counter increment is inside the 200-response block).
- **Races:** `openCommitments` / `passiveWaitCommitments` / write-rate counters are in-memory maps — Node's single-threaded event loop means check-and-increment is atomic per session.
- **Feedback loops:** none. Commitment writes don't trigger subsystem re-emissions.

## 6. External surfaces

- Other agents / external systems: unchanged.
- Persistent state: commitment entries now appear in the shared-state.jsonl (under session-asserted provenance). v1 render path handles unknown-kind fallback per spec §"v1 backward compatibility" — the new `commitment` kind is already in v1's VALID_KINDS enum (slice 1 didn't change that). Fields `commitment` and `disputes` pass through the entry construction; v1 readers will see extra fields and ignore them (JS/JSON semantics).
- Rollback: revert the slice 3 commit; commitments written during the observation window remain in the ledger with the `commitment` field visible to any reader that understands it. v1 renderers continue to render them by falling through to subject/summary.

## 7. Rollback cost

- Pure code revert. No schema migration. Commitments on disk stay as JSONL entries; a reverted server treats them as entries with unknown-but-ignorable extra fields. No user-visible regression with `v2Enabled=false`.

---

## Conclusion

Slice 3 opens the commitment write path with the validations that can be done without cross-registry lookups. All the heavy validation (real mechanism-ref resolution, Unicode confusables dedup, trust-tier resolution, per-agent ceiling) is cleanly deferred to slice 5. The resolve workflow is slice 4. 126 tests across the affected suites pass; typecheck clean; signal-vs-authority compliance holds.

Slice 3 ready for second-pass.

---

## Second-pass review (required)

**Reviewer:** independent reviewer subagent (Phase 5).
**Independent read of the artifact:** **CONCUR** with two non-blocking concerns.

### Verification summary (from reviewer)

- Signal-vs-authority: PASS. Deadline range is sanity bounds against past-dated spoofing, not judgment. Mechanism enum closed-set match.
- `refStatus` server-bound: PASS. Destructured pickup of `{type, ref}` only; no client path injects refStatus.
- Counter-on-failure: PASS. `recordOpenCommitment` runs AFTER the 200 return path; dedup-hit and IO-failure both skip the increment.
- Kind-aware forbidden: PASS. Note with inner `commitment` object returns 400.
- Deadline-in-past + passive-wait-requires-deadline: PASS with microsecond TOCTOU (harmless).
- Rate-limit ordering: commitment-cap check precedes write-rate check; `over-open-commitments` surfaces first. Acceptable per spec.

### Minor concerns (non-blocking, carried forward)

1. **Dedup/IO 409 collapse.** The fail-open 409 doesn't disambiguate "duplicate dedupKey" from "IO failure." Client sees `X-Dedup-Or-Fail: 1` without knowing which. Slice 4 is the natural place to split this since the resolve endpoint needs precise idempotency semantics.

2. **Dedup-replay quota.** A retry with the same dedupKey correctly does NOT burn counter quota (verified — `recordWrite` runs after the !appended return). No action needed.

### Verdict

**Slice 3 ready to commit.**
