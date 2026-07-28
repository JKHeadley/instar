# Side-Effects Review — feedback-factory fix verifier (Phase 1, increment 5)

**Slug:** `feedback-factory-verify`
**Date:** `2026-05-27`
**Author:** Echo (autonomous)
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved by Justin 2026-05-26)
**Scope:** `can_transition_to_verified` (:1084) — decide whether a fixed cluster has stayed fixed (version-anchored HIGH-confidence + silence-based LOW-confidence). The real `datetime.now()` + recent-reports query are injected by the caller; this is the pure decision.

## Summary of the change

Byte-exact port of `can_transition_to_verified` from `the-portal/.claude/scripts/feedback-processor.py` to `src/feedback-factory/processor/verify.ts` (`canTransitionToVerified`). Pure: `now` and the version-anchored query result (`recentReportsSinceFix`) are injected via `VerifyOptions` (the real store adapter does `datetime.now()` + the query). Adds `pyFormat0f` (Python `:.0f` round-half-to-even), the parity harness, and Tier-1 unit tests. **Not wired into any route/job yet** — no behavioral change.

## Equivalence verification

- **9/9 cases match the REAL `can_transition_to_verified`.** The parity harness monkeypatches the reference's `datetime` (so `.now()` returns each case's fixed `now`) and `run_prisma_query` (so the version-anchored query returns each case's `recentReportsSinceFix`), then runs the actual, unmodified function — full result object compared (allowed, evidence, recommendation, confidence, verified_by). Cases cover: no-fix-timestamp, silence too-soon/quiet-enough, version-anchored recent-reports/clean/under-24h-fallthrough, the `dispatchedAt` fallback, fractional-hours `:.0f` rounding, and multi-report frequency.

## Seven-dimension review

1. **Over/under-reach** — Pure deterministic function (given injected now + reports), no I/O, no global state, not imported by any runtime path.
2. **Level-of-abstraction fit** — Processor-logic layer. Time + DB are injected at the function boundary (dependency injection), keeping the decision pure + the real query/clock in the adapter — the cleanest seam.
3. **Signal vs Authority** — N/A; produces a recommendation object. The actual transition is still gated by `canTransition` (increment 3) + the curated lifecycle.
4. **Interactions** — None. New isolated module. Parity scripts LOCAL-only.
5. **Rollback cost** — Trivial: delete the module + tests + scripts.
6. **Migration parity** — N/A. New internal library code; no agent-installed file touched.
7. **Failure modes** — (a) Port diverges → parity harness (9/9, against the real function) + unit tests. (b) `:.0f` half-rounding divergence → `pyFormat0f` unit-tested on exact-half cases + parity (fractional-hours case). (c) Timezone/ISO parse divergence → both sides parse to epoch ms (UTC); corpus uses tz-aware Z timestamps; parity verifies. (d) Caller forgets to inject `recentReportsSinceFix` when version+fingerprint present → treated as empty (no recent reports), matching "no recurrence"; documented in the type.

## Tests

- Tier-1 unit (CI): `tests/unit/feedback-factory/verify.test.ts` — pyFormat0f (half-to-even), no-timestamp, version-anchored revert/high/fallthrough, silence verified, dispatchedAt fallback. 7 tests.
- Parity (local gate, evidence): `scripts/feedback-factory/verify-parity.mjs` → **9/9** vs the real `can_transition_to_verified`.
- No integration/E2E this increment: not wired to a route/job; those tiers attach when the transition driver + job land. Reasoned decision, documented.
