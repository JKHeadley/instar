# Convergence Report — Pool-Aware Quota Throttle

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI on every round (gemini was available
but degraded with a timeout on round 1; codex carried the external read across rounds 1–3). The final
codex round returned MINOR ISSUES (non-material, forward-looking) — recorded as accepted notes in the
spec.

## ELI10 Overview

The agent can run on several Claude accounts at once, pooled together. A "brake" decides, before
starting any work, whether there's quota to run. That brake used to look at a single account's usage
and, if it was high, stop the *whole* agent — even when other accounts were completely fresh. That's
the bug the operator hit: one account at 100% froze everything while two accounts sat at 0%. This
change makes the brake reason about the whole pool by asking the placement layer (the part that picks
which account to use) "is there a placeable account, and how much room does it have?" — so the brake
and the placer share one decision and can never disagree. It also handles missing/garbage quota
readings gracefully (run important work, shed only low-priority background work) instead of either
freezing or running blindly.

## Original vs Converged

The spec changed substantially through review — twice.

**Original design:** the quota collector would fold per-account snapshots into the quota state file,
and the brake would read that file. Review **rejected** this: (1) it was *dead in production* — the
collector is built without the registry path it needed, so the data was never written live; (2) the
brake (reading the file at a 95% threshold) and the placer (reading the live pool at a 90% threshold)
used different sources at different cutoffs, so in the 90–95% band the brake said "go" while the placer
couldn't place — a restart loop; (3) stale/error snapshots were folded in as fresh "0%" accounts.

**Converged design:** the brake asks the placer's *own* function (`selectAccount`) directly, reading
the live pool. This makes "the brake allows" and "the placer can place" the same decision by
construction — the loop band is gone, the staleness is gone, and it actually runs in production (wired
in server.ts). A second round of review found the new path didn't apply the bounded "degraded data"
protection; that was added (a shared helper, a data-quality guard, clamping of out-of-range readings,
and an explicit "all accounts rate-limited → stop, self-clearing" boundary).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | integration, adversarial, lessons-aware, decision-completeness, security(LOW), codex | 5 (F1 dead-in-prod, F2 loop band, F3 stale-as-fresh, F4 bounded fail-open, F5 effective-usage) | Full redesign to the provider approach |
| 2 | adversarial (F6), lessons-aware (A/B/C), codex (minor) | 3 (pool-path had no degraded/clamp/staleness guard) | Added shared bounded helper, data-quality guard, provider clamp+degraded signal, rate-limited boundary |
| 3 | (converged) — adversarial + lessons-aware both "CONVERGED"; codex MINOR (non-material) | 0 | Accepted-notes section for codex's forward-looking minors |

Standards-Conformance Gate: ran (0 flags) on round 1.

## Full Findings Catalog

**Round 1 (all resolved by the redesign):**
- F1 [HIGH] dead in production (collector built with no registryPath). → Provider reads live pool; wired in server.ts; integration-tested through the real route.
- F2 [HIGH] throttle/placement eligibility mismatch (90–95% respawn-loop band). → Throttle asks placement's own selectAccount; allowed⟹placeable by construction; pinned by the band test + a 0→100 invariant sweep.
- F3 [HIGH] stale error-branch snapshots folded as fresh 0% headroom. → Collector fold reverted; provider reads live status-aware pool.
- F4 [MED] unbounded fail-open / not gated to non-authoritative source. → Bounded degraded mode (shed low, allow medium+, honor authoritative 5h wall); gated to non-authoritative; authoritative >100 still stops.
- F5 [MED] "effective usage" undefined. → Reuses placement's bindingUtilization = max(weekly, 5h).

**Round 2 (all resolved in round 3):**
- F6 / A [MED] bounded degraded protection guarded only the file path, not the pool path. → Shared boundedDegradedDecision helper + a pool-path data-quality guard + a provider `degraded` signal when no trustworthy reading exists.
- B [MED] per-account utilization unclamped; implausible inputs could be selected as headroom. → Provider clamps to [0,100], throttle guards non-finite/out-of-range → bounded; tested over [186, -5, NaN].
- C [LOW/MED] all-rate-limited → stop, undocumented. → Documented as a decision boundary; confirmed self-clearing (re-evaluated each call, never latched); tested.

**Round 3 (non-material, accepted):**
- codex minor #1: throttle couples to selectAccount's semantics (future ranking changes leak in). → Accepted; clean future shape noted for the optimizer PR.
- codex minor #2: gating the single best-by-score account can be marginally stricter for a priority. → Accepted; errs toward shedding (safe direction).

## Convergence verdict

Converged at iteration 3. No material findings in the final round (both internal high-signal reviewers
returned "CONVERGED — no material findings"; codex returned non-material minors). Implementation and all
three test tiers are green (253 quota tests pass, no regressions). Spec is ready for approval.
