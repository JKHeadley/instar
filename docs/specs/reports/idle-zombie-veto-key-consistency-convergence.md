# Convergence Report — Idle-Zombie Veto-Backoff Key Consistency

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI (round 3, verdict MINOR ISSUES —
all five refinements folded in). Honest model posture: internal reviewers on Opus 4.8; codex
external on GPT-5.5; the Gemini door is unavailable (gemini-cli retired 2026-06-18) — so this is
"the strongest AVAILABLE model on each REACHABLE door," per operator directive. Fable 5 was not
used (gated until ~Jul 7).

## ELI10 Overview

We shipped a fix that was supposed to stop a wasteful loop — the agent re-trying to clean up a
session it isn't allowed to clean up, every 5 seconds forever. The live logs proved the fix
didn't actually work: the same warning printed 2,523 times at an exact 5-second cadence. The
root cause is that two parts of the code disagreed about *why* a session was kept, so the
"back off for 30 minutes" memory got thrown away and rebuilt every tick and the timer never held.
This spec is the fix: make both parts use the same reason, in the same order the real cleanup code
uses. The trustworthy part isn't the three lines of code — it's a CI test that runs the *real*
cleanup code as the source of truth and fails automatically if the two sides ever disagree again,
so the "keep them in sync" rule is enforced by a machine, not by memory.

## Original vs Converged

- **Original** parked the core design as a menu: "resolve during convergence — either mirror the
  precedence, or extract a shared helper, or change the comparison." The convergence process
  **collapsed that fork to one resolved approach**: mirror the terminate precedence in the
  pre-check (option a), because the shared-helper (option b) is not a clean pure extraction —
  the real cleanup method interleaves operator-bypass, a five-flag bypass set, a known-dead skip,
  a compare-and-set status check, and an in-flight check that reads live mutable state. Extracting
  those cleanly would mean a wide, risky refactor of the most safety-critical method for a
  cooldown-key fix.
- The **Structure-beats-Willpower objection** (two code paths kept in sync by discipline is the
  anti-pattern that caused THIS bug) was answered structurally, not waved off: the converged spec
  adds a **CI equivalence property test** that uses the *real* cleanup method as the oracle and a
  **classification-completeness assertion** so a future new gate can't stay silently green. The
  lessons-aware reviewer, which argued for the shared helper in round 1, explicitly **withdrew that
  preference** once the property test made the drift a machine check.
- The **exact algorithm** was pinned (protected → standby → reapGuard, with the mandatory
  `isAwakeMachine` presence-guard and the "keep `blocked` raw, override only `reasonKey`"
  contract), the tests were strengthened from single-tick key-equality to **multi-tick hold
  assertions on the real cost** (terminate-attempt + reap-log-write counts, not just the warning),
  and the `protected`-set equivalence (two syntactically different sources) was made a **tested
  invariant** rather than an assumption.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | adversarial, integration, decision-completeness, lessons-aware, scalability | 7 (design fork unresolved; exact precedence algorithm; isAwakeMachine presence-guard; blocked-stays-raw; multi-tick tests; residual bound; §2 order nit) | §3 resolved to option (a) with exact algorithm; §4 rebuilt (equivalence property test + multi-tick cells); §2 order corrected; §5/§6 posture + migration-parity |
| 2 | lessons-aware | 1 (property-test oracle must be the REAL method, not a model; equality matrix scoped to mirrored reasons) | §4 tightened: oracle = production terminateSessionInternal; matrix scoped |
| 3 (external: codex GPT-5.5) | codex | 5 minor (property-test completeness on new gates; protected-set equivalence as tested invariant; assert cost not symptom; already-* filter citation; narrow-helper rejection) | §4 completeness assertion + cost assertions; §2 protected-equivalence tested; §3 already-* citation + narrow-helper rejection |
| 4 | (converged) | 0 | none |

Standards-Conformance Gate: ran (0 blocking flags; signal-only).

## Full Findings Catalog

Round 1 (internal panel, all verified against real source — SessionManager.ts, VetoedKillBackoff.ts,
ReapGuard.ts):
- **Design fork parked (decision-completeness, lessons-aware, adversarial, integration) — CRITICAL.**
  Resolved to option (a) + property test.
- **Exact precedence algorithm required (adversarial, integration, decision-completeness) — HIGH.**
  `protected` (via reapGuard) → standby `not-lease-holder` → reapGuard reason. Spelled out normatively.
- **`isAwakeMachine` presence-guard (integration) — HIGH.** Optional field; `this.isAwakeMachine &&
  !this.isAwakeMachine()` mandatory + unset test. Applied.
- **Keep `blocked` raw, override only `reasonKey` (adversarial) — MED.** Preserves the single-guard-eval
  threading. Applied.
- **Multi-tick tests, not single-tick equality (lessons-aware, P14) — HIGH.** Every cell driven across
  many ticks. Applied.
- **Residual bound for in-flight/already-* (adversarial, lessons-aware) — MED.** Named non-recurring
  by construction; flap test added.
- **§2 terminate-order prose nit (decision-completeness) — LOW.** reapGuard cascade before in-flight.
  Corrected.

Round 2 (internal convergence check): decision-completeness CONVERGED; adversarial CONVERGED (all
three holes closed — idle-zombie caller sets no bypass flags, so terminate consumes the precomputed
verdict verbatim; `protected` is reapGuard's first-returned reason; threading preserved);
lessons-aware CONVERGED on the decision + 2 wording tightenings to §4 (real-method oracle; matrix
scope) — applied.

Round 3 (external codex GPT-5.5, MINOR ISSUES): (1) property-test completeness on a future new gate
→ classification-completeness assertion added; (2) protected-set equivalence across two syntactically
different sources → made a tested invariant; (3) narrow-helper alternative → considered + rejected in
§3; (4) already-* upstream filter → cited (idle-prompt tracking); (5) assert cost not symptom →
terminate-attempt + reap-log-write assertions added. All applied.

## Convergence verdict

Converged at iteration 4. The internal panel reached zero material findings by round 2; the external
GPT-5.5 pass in round 3 produced only minor refinements (no serious/blocking finding), all folded in;
round 4 carries no material findings. The design fork is resolved, `## Open questions` is genuinely
empty, and the load-bearing structural guard (the CI equivalence property test using the real
terminate method as oracle) is specified. Spec is ready for user review and approval.
