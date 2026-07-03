# Per-target failure-swap timeout (fixes gemini-swap-timeout)

<!-- bump: minor -->

## What Changed

The IntelligenceRouter failure-swap loop bounded EVERY swap attempt with one
global cap (`intelligence.swapAttemptTimeoutMs`, default 5000ms). Measured
provider latency (llm-pathway-bench, N=30, uncontended) shows gemini-flash's
p50 is 8,538ms — ABOVE the 5s cap — so whenever gemini was a swap target it was
SIGTERMed before it could answer on the majority of attempts: it reliably
burned a full 5s swap slot and then failed, poisoning the failover tail
(the R4 gemini-swap-timeout finding).

Per `docs/specs/per-target-swap-timeout-spec.md` (review-converged 2026-07-01,
approved), the cap now resolves PER TARGET FRAMEWORK with three new optional
`intelligence` config fields, all defaulting UNSET (dark ship — routing/timeout
behavior is byte-identical to today until an operator opts in):

- `swapAttemptTimeoutMsByFramework` — per-target caps. Resolution per swap
  target: `byFramework[target]` (valid = finite number > 0) → the global
  `swapAttemptTimeoutMs` → no cap. An INVALID value (0, negative, NaN,
  non-number) falls through to the global — never "no cap", never a 0ms kill
  (FD5: per-framework config cannot express "unbounded"; only the global's
  ≤0/unset does). Recommended opt-in package:
  `{ "claude-code": 8000, "pi-cli": 9000, "gemini-cli": 18000, "codex-cli": 45000 }`.
- `swapAttemptTimeoutMsMax` — clamp on any single resolved cap (invalid/unset
  ⇒ 120s) so a typo'd huge value cannot pin a host spawn-cap slot unbounded.
- `swapTotalBudgetMs` — wall-clock TOTAL budget over the whole swap tail
  (recommended 40000, set together with the per-target caps). When set, each
  attempt's effective cap is `min(resolvedCap, budgetRemaining)` on a MONOTONIC
  clock (never Date.now()), and the loop stops and falls closed once ≤250ms
  remains — so the worst-case swap tail is literally ≤ the budget. Unset ⇒ no
  enforcement (today's semantics).

Also: the swap timeout timer is now cleared on settle (`withSwapTimeout`
helper) so a fast success no longer leaks a pending timer per call; a stray/
misspelled `byFramework` key warns once and is ignored (falls through to the
global). The `swap-attempt-timeout:` degrade-reason format is unchanged.
`failureSwap` ORDER remains latency-load-bearing (sequential loop) — order
fastest-first; keep caps ≤ the circuit breaker's failure sensitivity.

Rollback: remove the config block → instant revert to the global cap. No
migrateConfig entry (absence is the default state, codexExecJson precedent).

## What to Tell Your User

<!-- audience: agent-only, maturity: preview -->
- **Backup AI routes now get fair deadlines (off until you opt in)**: when my
  main AI route fails mid-decision, I try backups — but every backup shared one
  five-second deadline, and one of my backups (gemini) usually needs about nine
  seconds, so it was being cut off before it could ever answer. I can now give
  each backup its own deadline matched to how fast it really is, plus an
  overall time limit so a chain of backups can never keep you waiting too long.
  Nothing changes until we turn it on — if you'd like, I can enable the
  recommended settings for you and undo it just as easily.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Per-target swap-attempt caps | `intelligence.swapAttemptTimeoutMsByFramework` in `.instar/config.json` (unset = today's global cap) |
| Per-attempt clamp | `intelligence.swapAttemptTimeoutMsMax` (invalid/unset ⇒ 120s) |
| Total swap-tail budget | `intelligence.swapTotalBudgetMs` (unset = no budget enforcement) |

## Evidence

- Live measurement (the bug): llm-pathway-bench R4 characterization, N=30
  uncontended — gemini-flash p50 = 8,538ms, p95 = 15,726ms vs the 5,000ms flat
  cap: every median-speed gemini swap attempt was killed at the cap before it
  could answer (observed as `swap-attempt-timeout: gemini-cli` degrade reasons;
  the attempt burned the full 5s slot and produced nothing). Other measured
  targets for scale: claude ~3s p50 / ~6s p95, pi ~4.6s / ~7s, codex ~18s / ~43s
  — no single cap fits all four.
- After (mechanism, exercised end-to-end in-process): with the recommended 18s
  gemini cap, an 8.5s-latency gemini target is SERVED on swap
  (`tests/integration/per-target-swap-timeout.test.ts`, wired with the server's
  exact threading expressions); with no per-framework config the same target is
  abandoned at exactly 5s and the call fails closed — byte-identical to before
  (regression tests pin the cap value the provider subprocess receives).
- The field fix requires the operator opt-in (dark ship); the delivery
  follow-through is tracked as commitment CMT-1889 (surface the recommended
  values as a one-tap go/no-go).
