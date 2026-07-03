# Benchmark Application (S1/S2/S5)

<!-- bump: patch -->

## What Changed

INSTAR-Bench v3 established the "door penalty": the identical Opus 4.8 model scores 99.1% on bounded judging via a clean API but only 81.7% through the Claude Code CLI door (73% on emergency-stop) — the CLI harness's ~20k-token coding-agent framing turns a skeptical judge credulous. Rules R1/R2 forbid routing any bounded/gating verdict through that door. This ships the three low-risk, dark/reversible pieces of applying that finding to routing, without moving any live routing default (the nature-axis router is separately spec-gated):

- **S2 — safety guardrail (the load-bearing piece).** The IntelligenceRouter's failure-swap now clamps a bounded/gating swap that lands on `claude-code` from the `capable` tier (Opus) down to `balanced` (Sonnet 4.6 CLI — 99.5%, 28/28 adversarial). It only ever NARROWS a fallback in the safe direction; it never blocks a call and never touches the open-ended-writing quality lane where Opus-via-CLI is the legitimate primary. A new lint (`lint-no-opus-claude-cli-gating.js`) keeps the clamp intact and refuses any committed config that routes a gating call to Opus×claude-CLI.
- **S1 — cite-the-bench, extended.** A new registry-doc freshness lint (`lint-routing-registry-freshness.js`) fails the build if any benched component lacks a row in `docs/LLM-ROUTING-REGISTRY.md`, and a new `LLM_ROUTING_NATURE` map records each component's bench-cited task-nature (A/B/D/E) and production chain (FAST/SORT/JUDGE/WRITE). Read-only metadata — it changes no routing today.
- **S5 — bench-refresh job.** A scaffolded, OFF-by-default, tier-1-supervised monthly job that reruns the bench harness + parity-check and raises ONE operator-review diff when a routing default looks stale. It never auto-applies a change and no-ops on any machine without the bench harness.

## Evidence

- `tests/unit/opus-claude-cli-gating-guardrail.test.ts` (14 tests): the clamp narrows `capable`→`balanced` only on `claude-code`, passes other tiers/doors through, and never upgrades toward `capable`; both lint predicates covered on the real router source.
- `tests/unit/llm-routing-nature-ratchet.test.ts` (6), `tests/unit/routing-registry-freshness.test.ts` (2), `tests/unit/bench-refresh-job-template.test.ts` (8) — all green.
- `npm run lint` green with both new lints; `tsc --noEmit` clean; the affected router + ratchet suites (98 tests) green. Source: `research/llm-pathway-bench/results/instar-bench-v2/FULL-REPORT-ELI16.md` §7.7/§9 (door penalty, R1/R2).

## Summary of New Capabilities

- A structural clamp making the measured-banned Opus×claude-CLI route unreachable via a bounded/gating fallback swap.
- Two new CI lints: routing-registry freshness (every benched component has an intentional-defaults row) and no-opus-claude-cli-gating (the R1/R2 guard).
- A bench-cited nature/chain map joining benchmark coverage to routing.
- An off-by-default monthly bench-refresh job that surfaces routing drift for operator review.

## What to Tell Your User

Under the hood I tightened how I pick which AI model runs my background safety checks. A benchmark found that one strong model becomes unreliable at yes/no judging when it's called through a particular tool door, so I added an automatic safeguard: if one of those checks ever falls back to that door, I quietly step down to a model that stays sharp there. It only ever makes the fallback safer — nothing you see changes, and I never switch the model your actual conversations run on without asking. I also added build-time checks so this discipline can't quietly rot, and an off-by-default monthly job that can flag a routing change for you to review — but a change like that always waits for your say-so.
