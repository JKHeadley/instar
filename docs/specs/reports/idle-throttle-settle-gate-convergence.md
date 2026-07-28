# Convergence Report — Idle-monitor throttle settle-gate

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI (verdict MINOR ISSUES); gemini-2.5-pro also ran (MINOR). Both noted: (codex) the "cannot strand" claim leaned on the watchdog backstop and should be made explicit; (gemini) the new idle-path settle logic is architecturally redundant with the watchdog's (refactor vs parallel). Both folded into the spec — the safety claim now stands on the idle path's own per-tick re-sample (not the watchdog), and the redundancy is named as deliberate, reusing `evaluateThrottleSettle` (not a parallel implementation) with the unification tracked as CMT-1785. The Standards-Conformance Gate timed out (spawn-cap saturated by concurrent reviewers) — signal-only + fail-open, recorded unavailable, did not block.

## ELI10 Overview

Echo has two watchers that notice when a chat session is stuck on an AI-provider "slow down" message and hand it to a recovery helper. One (the watchdog) is careful — it only acts once the screen has stopped changing (a working session animates its spinner, so a frozen screen with a throttle on it proves the session genuinely stopped). The other (the idle monitor) was naive — it acted the instant it saw the throttle *word*, even if that word was stale scrollback or a throttle that already cleared. That naive trigger produced unnecessary recovery pokes. This change gives the idle monitor the same careful settle check, behind a dark switch (dev-only until soaked). It can only make the idle monitor act *less* often, never more, so it can't strand a genuinely-stuck session — it just stops acting on a stale/transient throttle word.

## Original vs Converged

The original draft put the settle check inside the idle monitor's *first-idle-tick* block. Adversarial review found that was a critical functional defect: a "has the screen stopped changing?" check needs to re-sample across ticks, but running it only once meant it could never reach "settled" — so with the flag on, the idle path would emit recovery *never*, silently delegating the entire job to the separately-disableable watchdog (breaking the "never strands" promise if the watchdog were off). The converged version runs the settle check on *every* idle tick (ahead of the first-tick gate), so "settled" is reachable on the idle path's own merits; the legacy instant emit is fenced to flag-off. A low-severity map-cleanup leak (cleanup registered only inside `setPromptDetector`) was moved to an unconditional constructor registration. The safety claim, the polling-vs-watchdog redundancy, and the per-tick capture cost were all made explicit per the external reviewers.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec/code changes | Standards-Conformance Gate |
|-----------|-----------------------|-------------------|-------------------|----------------------------|
| 1 | adversarial (1 critical + 1 low), codex+gemini (minor); decision-completeness + lessons/integration clean | 1 critical (F1: settle unreachable — first-tick-only) + 1 low (F2: cleanup leak) | Restructured to per-tick settle re-sample; unconditional cleanup; spec safety-claim + redundancy + capture-cost notes | unavailable (timed out — spawn-cap; fail-open) |
| 2 | (verification) adversarial RESOLVED+CONVERGED | 0 | none | n/a |

## Full Findings Catalog

**Round 1 — material:**
- **F1 (CRITICAL, adversarial)** — the settle check lived inside the first-idle-tick `if (!idlePromptSince.has)` block; the `'wait'` branch `continue`d without re-entering, so the settle clock was written once and never re-sampled → `'settled'` structurally unreachable → flag-ON emitted recovery never, delegating to the watchdog (a strand path if the watchdog is disabled). **Fix:** the settle check now runs on EVERY idle tick (a block inside `if (isActuallyIdle)` ahead of the first-tick gate); the legacy first-tick emit is fenced to `!idleThrottleSettleGate`. Verified resolved round 2.
- **F2 (LOW, adversarial)** — the settle-map cleanup `sessionComplete` listener was registered only inside `setPromptDetector`, leaking the entry for a session killed mid-`'wait'` in a wiring that never sets a prompt detector. **Fix:** registered unconditionally in the constructor; conditional copy removed. Verified resolved round 2.

**Round 1 — external minor (folded into the spec):**
- codex: "cannot strand" overstated — leaned on the watchdog. Resolved: the claim now stands on the per-tick re-sample; the never-settling case = an animating (working) session, the same property the watchdog has.
- gemini: architectural redundancy (parallel settle vs refactor). Resolved: named as deliberate — `nextIdleThrottleAction` reuses `evaluateThrottleSettle` (thin wrapper, not a duplicate); the two-path unification is CMT-1785.

**Round 1 — clean:** decision-completeness (3 frontloaded verified, 0 contested, Open questions = none); lessons/integration (dev-gate wiring correct, machine-local, foundation sound, signal-not-authority correct, no double-recovery — `RateLimitSentinel.report()` dedupes the two emits).

**Round 2 — verification (adversarial):** F1 + F2 resolved; new checks clean — `'wait'` deferring idle-kill is bounded (a never-settling pane = animating/working, not idle-stuck; it settles→emits or the throttle scrolls out → fall-through → idle-kill resumes); flag-OFF byte-identical to legacy; decision boundaries correct. One non-blocking note (per-tick wider capture cost when flag ON) — already documented in the spec's scalability note + deferred to the CMT-1785 unification; not a correctness gap.

## Convergence verdict

Converged at iteration 2. Zero material findings in the verification round; `## Open questions` is `*(none)*`. The one critical defect was caught by adversarial review and fixed with a structural per-tick re-sample (verified resolved); the low-severity leak was fixed. 130 unit tests green across the rate-limit / watchdog / new suites (6 new for `nextIdleThrottleAction` covering every decision boundary), no regression, clean typecheck, flag-off path byte-identical to legacy. Spec ready for approval.
