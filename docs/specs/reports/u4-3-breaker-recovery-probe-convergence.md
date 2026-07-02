# Convergence Report — U4.3 Rope-Health Recovery Probe

## Cross-model review: codex-cli:gpt-5.5

Real GPT-tier external passes ran in rounds 1, 2, 3, and 4 (all MINOR);
gemini-2.5-pro passed in rounds 1 (after retry), 2, and 3 (MINOR; round-4
timeout covered by codex). Clean RAN state.

## ELI10 Overview

When a network rope between the agent's machines dies and later heals, the mesh
never notices the healing — a healed Tailscale connection once stayed presumed-dead
for a WEEK. This adds a small background probe that deliberately re-tests unhealthy
ropes and feeds the results into the existing health records, so recovery takes
minutes, bounded and quiet.

## Original vs Converged

The original draft targeted a "circuit breaker" that does not exist — review
grounded the design on the real primitive (per-rope health records) and found the
TRUE root causes: the dial-racing code never re-dials a rope marked dead, and — a
second, hidden cause — when a recovering rope loses the race, its CANCELLATION is
recorded as another failure, resetting its recovery progress forever. The converged
design fixes the accounting bug in the dialer (which also benefits the two sibling
features), and adds an in-process, episode-scoped prober: an episode opens when a
rope dies and only closes when the rope fully re-earns trusted status or reaches a
bounded, loudly-announced floor. Episode scoping was itself a round-3 catch — the
earlier per-state selection had a limbo hole (one failed probe after partial
recovery stranded the rope permanently) and a cadence hole (a slow-but-alive rope
would have been probed every five seconds forever). Probing forever at a capped
floor is a declared constitutional exemption for critical healers — with a single
escalation to the operator, never silence and never a hard stop. Ships live on the
development pair in observe mode from day one.

## Iteration Summary

| Round | Reviewers | Material findings | Changes |
|---|---|---|---|
| 1 | 6 internal + codex(MINOR) + gemini(MINOR) + gate (3 flags) | ~6 | Reground on the real resolver; hedge-starvation root cause; Eternal-Sentinel exemption — commit e85f75365 |
| 2 | 2 combined panels + externals | 5 deduped | Hedge-abort accounting fix (second root cause); episode brake; close semantics matched to code; probe-layer scheduling state; receiver-cost honesty — commit 2737fc4b5 |
| 3 | all-lens panel + externals (MINOR) | 2 | EPISODE-scoped selection (limbo + cadence holes); mid-recovery interval + success-path floor bound — commit 5c9fc1da3 |
| 4 | confirm panel + codex(MINOR) | 0 — CONVERGED | none |

## Convergence verdict

Converged at iteration 4. The round-4 panel verified the episode mechanism at all
sites (old predicate historical-only, both new knobs frontloaded with defaults,
both new test arms pinned) and found no material findings. Zero open questions.
Ready for approval.

Decision-completeness evidence: frontloaded-decisions 8 · cheap-tags 0 ·
contested-then-cleared 2.
