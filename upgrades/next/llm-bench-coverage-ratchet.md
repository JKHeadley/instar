<!-- bump: patch -->

## What Changed

INSTAR-Bench v2 ratchet #2 (spec §6; operator directive 2026-07-02, topic
29723): a new coverage ledger (`src/data/llmBenchCoverage.ts`) maps every LLM
component in `COMPONENT_CATEGORY` to its benchmark status — covered by a
named bench task (the 10 Wave-1 critical gates/sentinels), pending (42,
pinned shrink-only), or exempt (1, argued). A CI test
(`llm-bench-coverage-ratchet.test.ts`) fails the build when a new LLM
component ships without a coverage decision, when the pending/exempt sets
GROW (graduating shrinks them; adding requires editing the pinned baseline in
the test — a visible, reviewed act), when an exemption's argument is lazy, or
when a Wave-1 critical component slides back to uncovered.

Together with the existing attribution ratchet + category-map wiring test,
the chain is closed: every LLM callsite must be attributed → categorized/
routed deliberately → benchmark-covered. No runtime surface; build-time only.

## What to Tell Your User

Nothing proactively — no behavior changes. If asked: every one of my internal
AI helpers is now tracked against a benchmark coverage ledger, so any new
helper added to my infrastructure must ship with quality measurements (or a
written argument why not) before the build goes green. It keeps my model
choices grounded in measured results instead of guesses.

## Summary of New Capabilities

None user-facing. New build-time guarantee: `src/data/llmBenchCoverage.ts`
(the coverage ledger) + `llm-bench-coverage-ratchet.test.ts` (the CI ratchet).
The ledger is importable by future tooling (e.g. the bench runner's coverage
report) but nothing at runtime consumes it yet.

## Evidence

6 new tests green (completeness, no-dangling, shrink-only pins ×2, argued
exemptions, Wave-1 regression pin); `tsc --noEmit` clean; full unit suite
green at push.
