# Side-Effects Review — Pool-Aware Quota Throttle

**Version / slug:** `pool-aware-quota-throttle`
**Date:** `2026-06-16`
**Author:** `echo`
**Second-pass reviewer:** spec-converge multi-reviewer panel (6 internal + codex GPT-5.5), 3 rounds — see docs/specs/reports/POOL-AWARE-QUOTA-THROTTLE-convergence.md

## Summary of the change

Makes the global quota brake (`QuotaTracker.shouldSpawnSession`) pool-aware. Instead of stopping the
whole agent when ONE account's usage is high, it consults a new `poolHeadroom` helper in the placement
module (via an injected provider wired in `server.ts`). `poolHeadroom` shares `selectAccount`'s EXACT
eligibility predicate — so `placeable ⟺ selectAccount() !== null` (the never-loop invariant) — but
gates on the MOST-HEADROOM eligible account, so non-critical work runs whenever ANY account has room
(the 2026-06-16 live-proof fix: gating on `selectAccount`'s use-it-or-lose-it drain-first winner
wrongly shed medium/autonomous work even with a fresh 0% reserve). Placement (`selectAccount`) still
drains the soonest-to-reset account. A non-authoritative/implausible/missing reading triggers a
BOUNDED degraded mode (shed low priority, allow medium+, honor an authoritative 5h wall) rather than
an unbounded fail-open or a whole-agent stall. Files: `src/monitoring/QuotaTracker.ts` (provider +
bounded helper + data-quality guard), `src/core/QuotaAwareScheduler.ts` (the shared `poolHeadroom`
helper), `src/commands/server.ts` (wiring), `src/scaffold/templates.ts` (CLAUDE.md awareness).
Decision point: the spawn/job quota gate.

## Decision-point inventory

- `QuotaTracker.shouldSpawnSession` (the spawn/job quota brake) — **modify** — now reasons over pool
  placeability (shared with placement's `selectAccount`) instead of a single account's usage; adds a
  bounded degraded mode. This is the only decision surface touched.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The change REDUCES over-block — its whole purpose is to stop the brake from falsely halting the agent
when fresh accounts exist. New possible over-block: if EVERY account is status `rate-limited` (not
just high-usage), `selectAccount` returns null → STOP. This is correct (placement genuinely can't
land), and it is NOT latched — it re-evaluates every call and self-clears when a window resets. The
bounded degraded mode sheds `low` priority during untrustworthy readings — intended, conservative.

## 2. Under-block

**What failure modes does this still miss?**

A throttle "allow" guarantees placeability AT DECISION TIME; a concurrent spawn could consume the last
account before placement runs — placement then returns null, which the caller handles as a normal
back-off (NOT the old respawn loop, which came from throttle/placement disagreeing — now impossible).
The provider trusts the pool's own quota-poll freshness (same data placement already relies on); a
genuinely stale-but-present reading is the pool layer's concern, not newly introduced here.

## 3. Level-of-abstraction fit

The fix lives in the existing quota-gating module (`QuotaTracker`) and the existing server wiring —
the correct layer. It reuses placement's `selectAccount`/`bindingUtilization` rather than duplicating
eligibility logic, so there is one source of truth for "is this account placeable."

## 4. Signal vs authority compliance

`QuotaTracker` is an EXISTING authority (it gates real spawns). The change does not add a new brittle
blocking check — it makes the existing authority's decision pool-aware and adds fail-open/bounded
behavior in the safe direction. Fail-open on degraded data is exactly the Signal-vs-Authority guidance
(don't let an expensive false-positive stop everything). Lessons-aware reviewer confirmed PASS across 3
rounds.

## 5. Interactions

- **Placement (`QuotaAwareScheduler.selectAccount`):** now shared by the throttle — by construction
  they cannot diverge (closes the respawn-loop band). No change to selectAccount itself.
- **SubscriptionPool:** read-only (`list()`); no mutation.
- **QuotaCollector / QuotaManager:** unchanged (the earlier collector edit was reverted). The file
  path (single-account / legacy) is byte-identical except the bounded degraded mode.
- **Scheduler / can-start / spawn gates:** all consume `shouldSpawnSession`/`canRunJob` and benefit
  automatically; no signature change.

## 6. External surfaces

No new routes, no new config keys, no new dashboard surface. The only user-facing surface is the
CLAUDE.md template awareness blurb (additive). No external network calls added (the provider reads the
in-memory pool synchronously).

## 6b. Operator-surface quality

No operator-facing UI/route changes. The behavior the operator observes ("the agent no longer freezes
when one account maxes out; idle accounts get used") is the intended improvement, documented in the
CLAUDE.md awareness section so an agent can explain it conversationally.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** `quota-state.json` and the SubscriptionPool the throttle reads are
per-machine: each host polls its own account credentials and places sessions locally. Replicating
would be wrong (machine A's stale view would gate machine B's spawns). The existing
`GET /subscription-pool?scope=pool` is the unchanged cross-machine quota surface. No durable state is
introduced that could strand on a topic transfer. Documented in the spec's "Multi-machine posture"
section.

## 8. Rollback cost

Low. Pure code change, no persisted-state migration. Disable per-agent by leaving the provider unset
(or `setPoolQuotaProvider(undefined)`) → file-based gating returns. Full revert = revert the commit +
rebuild + restart sessions. Solo (single-account) agents are unaffected (no provider wired). No
dark-gate flag (this is a correctness fix, default-on, fail-safe — the prior behavior was the bug).

## Conclusion

The change removes a false-positive whole-agent halt, shares placement's exact eligibility so the
throttle and placer can't diverge (no respawn loop), and bounds degraded-data behavior in the safe
direction. Reviewed to convergence over 3 rounds (the first two designs were rejected and redesigned).
All three test tiers green; 253 quota tests pass with no regressions.

## Second-pass review (if required)

Done — the spec-converge panel (6 internal reviewers + codex GPT-5.5 external) served as the
multi-reviewer second pass across 3 rounds; both high-signal reviewers returned "CONVERGED — no
material findings" in the final round. Concurred: true.

## Evidence pointers

- Spec: `docs/specs/POOL-AWARE-QUOTA-THROTTLE-SPEC.md` (review-convergence + approved)
- ELI16: `docs/specs/POOL-AWARE-QUOTA-THROTTLE-SPEC.eli16.md`
- Convergence report: `docs/specs/reports/POOL-AWARE-QUOTA-THROTTLE-convergence.md`
- Round-1 findings: `docs/specs/reports/POOL-AWARE-QUOTA-THROTTLE-round1-findings.md`
- Tests: `tests/unit/quota-tracker-pool-aware.test.ts`, `tests/unit/quota-tracker-invalid-input.test.ts`, `tests/integration/pool-aware-quota-canstart.test.ts`
