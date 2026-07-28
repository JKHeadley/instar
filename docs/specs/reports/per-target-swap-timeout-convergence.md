# Convergence Report — Per-Target Failure-Swap Timeout

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI on ALL THREE rounds (verdicts:
MINOR ISSUES → MINOR ISSUES → MINOR ISSUES, each fully folded in). The gemini-2.5-pro external
pass ran CLEAN on rounds 1 and 2 and degraded (timeout) on round 3; per the aggregate rule a
successful external pass in a round yields the clean RAN flag, so the spec received genuine
cross-model review. No ⚠ — this is the clean-pass state.

## ELI10 Overview

The agent uses AI models to make fast safety decisions (like "is this an emergency stop?"). When
its first-choice model fails, it tries a backup — with a stopwatch that kills the attempt if it
takes too long. Today that stopwatch is one number (5 seconds) for every backup model. But models
answer at wildly different speeds: our benchmark measured Claude at ~3s, pi ~4.6s, gemini ~8.5s,
codex ~18s. So the 5-second stopwatch is *shorter than gemini's normal answer time* — gemini gets
killed before it can ever answer, making it useless as a backup.

This spec lets each model have its own stopwatch that matches its real speed. It ships "dark": by
default nothing changes; an operator opts in when they want. To make sure a slow model can't hold
up a user's message forever, there's also an overall time budget for the whole backup chain — and
(the key thing review caught) that budget now trims each attempt so the chain can *never* exceed
it, not just "check before starting."

If it ships and the operator turns it on: gemini becomes a working backup, and the total time a
backup chain can take is guaranteed to stay under the budget. If they don't turn it on, behavior is
exactly as today. The tradeoff: a backup chain that's *allowed* to wait for a slower-but-succeeding
model can take a bit longer than one that "fails fast" — but a backup that succeeds beats one that
gives up early and leaves the agent with no answer.

## Original vs Converged

The original spec was a small, correct idea — "give each model its own timeout" — but review
hardened it in three important ways:

1. **The safety timeout could be turned into a footgun.** Originally a per-model value of `0` or a
   typo could either kill every attempt instantly (a `NaN` timer fires immediately) or accidentally
   remove the timeout entirely. Converged: a strict validation rule — a per-model value only counts
   if it's a real positive finite number, otherwise it falls back to the global default. You *can't*
   accidentally uncap or instant-kill a model.

2. **"Bounded" wasn't actually bounded.** The first attempt at a total time budget only checked the
   clock *before* starting each backup — so a slow model admitted at the last second could still run
   its full time and blow past the budget (worst case ~150 seconds, worse than the problem it was
   fixing — this would have held up a user's outgoing message). Converged: each attempt is trimmed to
   the *remaining* budget, so the total is now genuinely guaranteed to stay under the limit. This was
   the single most important catch, found independently by every reviewer.

3. **It would have shipped and done nothing.** Because it's off by default, gemini stays broken until
   someone turns it on — a fix that's never applied. Converged: turning it on is delivered as a
   one-tap operator choice bundled with the recommended values, plus a tracked follow-up so the loop
   is actually closed, not just closable.

Plus smaller precision fixes: use a monotonic clock (so a system clock change can't corrupt the
budget), typed config keys (so a misspelled model name is caught), timer cleanup, and honest wording
about exactly what "unchanged by default" covers.

## Iteration Summary

Standards-Conformance Gate: ran each round (0 flags).

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware, codex-ext (gemini-ext CLEAN) | 8 | Added resolveCap validation contract (FD5), total swap budget (FD6), per-attempt clamp + timer-clear (FD7), delivery-closes-loop (FD8), typed keys, breaker/ordering/semaphore notes, P4 test carve-out, dashboard note, precise byte-identical wording |
| 2 | scalability, security, adversarial, integration, decision-completeness, lessons-aware, codex-ext (gemini-ext CLEAN) — ALL raised the SAME finding (NF1) | 1 | Each attempt clamped to `min(cap, budgetRemaining)` → tail literally ≤ budget; `swapTotalBudgetMs` defaults UNSET (true byte-identical); maxCap/budget values validated |
| 3 | 6 internal ALL CONVERGED; codex-ext 3 minor clarifications (gemini-ext degraded/timeout) | 0 material (3 minor clarifications folded in) | Monotonic clock for elapsed; softened "byte-identical" → "routing/timeout semantics unchanged"; stated the provider timeoutMs-hard-deadline contract; sub-250ms budget fail-safe note |

## Full Findings Catalog

**Round 1 (8 material):**
- [H] resolveCap invalid-value semantics undefined (security, adversarial, integration, decision-completeness, lessons-aware) → FD5: validate `number && isFinite && >0`, invalid falls through to global, never no-cap/instant-fire; never `||` (zero-is-falsy lesson).
- [H] No upper clamp + unbounded total tail (~85s) → reachability regression (security, scalability, adversarial, lessons-aware) → per-attempt clamp `swapAttemptTimeoutMsMax` (FD7) + total budget `swapTotalBudgetMs` (FD6).
- [M] Cap can mask a degraded provider from the circuit breaker (adversarial) → Safety note: caps ≤ breaker threshold; timed-out attempts still counted.
- [M] Sequential loop → target ORDER is latency-load-bearing (scalability, adversarial) → documented (fast-first; cap ≠ priority).
- [M] Long caps hold host spawn-semaphore slots ~10× longer (scalability, security) → Safety note; total budget mitigates.
- [M] Ships-inert / Close-the-Loop — dark default means gemini stays broken until opt-in (lessons-aware) → FD8: one-tap go/no-go + tracked commitment.
- [M] codex-ext: typed keys (`Partial<Record<IntelligenceFramework>>`) to stop typo-silent-fallback; timer-leak (clear the setTimeout on settle); "byte-identical" too strong; total-bound ignores primary attempt → all folded in.
- [L] Testing tier label — no HTTP route → no Tier-3 e2e (lessons-aware) → stated the Testing-Integrity no-route carve-out; [L] Signal-vs-Authority static-cap recurrence vector → noted; [L] dashboard/Agent-Awareness → "internal knob" note.

**Round 2 (1 material — unanimous):**
- [H] NF1: total budget only gated BEFORE each attempt, so worst-case = `budget + maxCap` (~150s), not `≤ budget` — the Safety invariant was false, reopening the reachability regression FD6 exists to close. Found independently by scalability, security, adversarial, integration, decision-completeness, lessons-aware, AND codex-ext. → Each attempt clamped to `min(resolvedCap, budgetRemaining)`; loop falls closed at remaining ≤ 250ms; budget defaults UNSET (codex backward-compat catch: `6×global` default would have changed behavior for configs with >6 targets / high global cap).

**Round 3 (0 material; 3 minor clarifications folded in):**
- 6 internal reviewers verified the NF1 fix makes worst-case tail literally ≤ budget, no starvation (250ms floor), all decisions frontloaded, "Open questions: none" honest, accurate-bound lesson satisfied, byte-identical confirmed for all configs. Non-material nits noted (sub-250 budget misconfig, "e.g." phrasing).
- codex-ext (minor, folded in): use a MONOTONIC clock for `elapsedSinceFirstSwap` (a wall-clock jump must not corrupt the budget); soften "byte-identical" to "routing/timeout semantics unchanged" + note timer-cleanup as an internal difference; state that a provider must honor `timeoutMs` as a hard subprocess deadline (existing behavior).

## Convergence verdict

Converged at iteration 3. The six internal reviewers unanimously found zero material findings in
round 3; the round-3 external raised three minor, non-design-changing clarifications which were
folded into the spec. `## Open questions` is empty (all eight decisions frontloaded, FD1–FD8). The
spec is ready for user review and approval.
