# Convergence Report — Resilient Degradation Ladder

## ⚠ Cross-model review: SKIPPED (abbreviated — internal multi-round, external CLI not built)

The external non-Claude (codex/gemini) pass was NOT run — it requires a `dist/` build this
spec-only worktree lacks. Mitigating context: convergence ran **three internal rounds** (7 reviewer
perspectives), and the dominant defect class every round was *ungrounded prior-art claims* — each
caught by reviewers reading the actual code (`IntelligenceRouter.ts`, `CircuitBreakingIntelligenceProvider.ts`,
`LlmCircuitBreaker.ts`, `LlmQueue.ts`, `DegradationReporter.ts`, `SubscriptionPool.ts`, `types.ts`).
The final round re-grounded every named seam (most importantly confirming `options.rateLimitWaitMs`
is a real, already-consumed field). The operator (Justin) reads this banner and approves with the
reduced-external-assurance state as an informed, pre-approved choice.

## ELI10 Overview

When your agent's AI provider hits a rate limit, the agent has to decide what to do — and the
operator's rule is: try the gentlest options first (slow down and retry), only switch providers if
that fails, only fall back to a dumb rule-of-thumb as a true last resort, and never quietly stay
stuck on that rule-of-thumb. This spec implements that as an ordered "ladder," extending the
machinery the agent already has (it already switches providers and already treats the rule-of-thumb
as a last resort) rather than rebuilding it.

The review changed the design in two important ways. First, "slow down" turned out to be wrong for
calls the agent is *waiting on* (a safety gate) — slowing those down just makes the agent hang — so
the ladder is now split: background work gets the gentle slow-down ladder, while a waited-on gate
keeps switching fast and stops safely if all switches fail. Second, one rung (switching to a
different account of the same provider) turned out to need brand-new machinery for a single internal
call, so it was cut from the first version (account-switching already works at the session level).
The headline new piece is the "never silently stuck" tracker, carefully designed to NOT repeat a
real event-loop freeze the same subsystem caused on 2026-06-21.

## Original vs Converged

- **Originally** the ladder applied backoff to ALL calls. Review found that stalls the synchronous
  gate path (the exact path the existing 5s swap-cap keeps responsive) — a ~28s worst-case stall.
  **Converged:** path-dependent — gates stay fast under a single 6s budget; only background/deferrable
  work gets backoff.
- **Originally** rung (b) account-swap was described as "wiring the existing pool." Review found per-
  internal-call account-swap is net-new mechanism (internal calls use a process-wide credential).
  **Converged:** cut to a later increment; the ladder works without it (account-swap exists at session
  level).
- **Originally** the "consequential call never hits a heuristic" safety claim was wired to the
  `gating` flag. Review found `gating` is a swap-eligibility flag, not a consequence flag.
  **Converged:** honestly scoped — gates fail closed (unchanged); a stronger consequence-based gate
  needs a new flag, held to a later increment.
- **Originally** §4 backoff said "the router drives the breaker." Review found the router holds no
  breaker. **Converged:** the router sets `options.rateLimitWaitMs` (a real field) and the provider
  layer waits.
- **Originally** §4 never-silent tracking didn't acknowledge the subsystem's prior wedge.
  **Converged:** explicitly bounded, reentrancy-safe (sweep never calls report()), liveness-gated
  (run-once components auto-close, no false alarm), O(1) mutation, inert-when-off, with a named
  `onResolved` success hook.

## Iteration Summary

| Round | Reviewers | Material findings | Spec changes |
|-------|-----------|-------------------|--------------|
| 1 | foundation-audit/lessons, adversarial, decision+integration (3) | ~10 (1 critical + several high) | v2 reshape: path-dependent ladder; cut rung (b); honest safety scope; §4 hardened vs the 2026-06-21 wedge; gating⇒never-deferred; queue-drain pacing |
| 2 | foundation+adversarial, decision+integration (2) | 4 (F1 backoff seam, F2 breaker scope, F3 success hook, F4 O(1) qualifier) | v3 grounding fixes using the reviewers' named seams (`options.rateLimitWaitMs`, account-global, `onResolved`, O(N) qualifier) |
| 3 | final verifier (1) | 0 (all F1–F4 confirmed grounded; `rateLimitWaitMs` confirmed real) | none |

Standards-Conformance Gate: not run this pass (the route timed out at 90s on the prior spec; signal-only, fail-open per the skill).

## Full Findings Catalog (material, by round)

**Round 1:** ladder backoff stalls the gating path (CRITICAL); rung (b) account-swap is net-new
mechanism mislabeled as wiring (HIGH); safety invariant wired to the wrong flag (HIGH); §4 re-extends
the 2026-06-21 DegradationReporter wedge without acknowledging the reentrancy/MAX_EVENTS/O(N)/run-once
classes (HIGH); herd re-introduction via account-swap + queue-drain (HIGH); gating⇒never-deferred only
a convention (MEDIUM); D3/D4 mislabeled cheap-to-change (BLOCKING framing); §8 not empty. → all
resolved in v2.

**Round 2:** F1 router can't drive `breaker.acquireOrWait` (the seam is `options.rateLimitWaitMs` one
layer down); F2 the breaker is account-global, not per-(component,framework); F3 §4 auto-resolve needs
a router success hook that doesn't exist; F4 O(1) claim collides with the reporter's existing O(N)
persist + two `src/core/` path prefixes. → all resolved in v3 using the reviewers' named seams.

**Round 3:** zero material findings. `options.rateLimitWaitMs` confirmed a real field (`types.ts:869`)
consumed by `CircuitBreakingIntelligenceProvider.evaluate()`; account-global breaker confirmed; no
success hook today confirmed; O(N) persist confirmed. §8 empty.

## Convergence verdict

**Converged at round 3.** Zero material findings; every named code seam verified to exist and be
described accurately; §8 empty (round-1's three blockers pulled into D-decisions). The spec extends
existing machinery, is honestly scoped (one rung + one stronger safety flag held to later
increments), and is hardened against the exact prior wedge it could have repeated. Ready for operator
review and build.
