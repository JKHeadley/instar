<!-- bump: patch -->

## What Changed

Builds FD4.2 of the (still-dark) nature-axis router (spec: docs/specs/nature-axis-routing.md §296-314): the R-rule structural-exclusion guards R3–R8 that keep a bench-condemned model placement out of the router's authored chains and per-component maps.

- **R3/R4/R5/R7 position bans** (src/core/IntelligenceRouter.ts + scripts/lint-nature-chains.mjs): a pure predicate (validateChainPositionRRule) and matching build-lint reject a chain that places qwen-tier in a strict-format position (R3), the gemini-cli door in a JUDGE safety-gate position (R4), gpt-oss-20b / llama-4-scout in a JUDGE position (R5), or a DeepSeek door/model in a JUDGE position (R7). Wired into both the config-load merge and the resolve-time chain check alongside the existing FD4 harness-door ban, so a violating operator override is rejected → built-in default.
- **R6/R8 component-map pins** (src/data/llmBenchCoverage.ts + the build lint): doc-tree/cartographer components (NATURE_ROUTING_CLAUDE_BANNED_COMPONENTS) may never route to any claude-code door (R6); the input-classifier components (NATURE_ROUTING_INPUT_CLASSIFIER_COMPONENTS) must stay injection-exposed and pinned off the Flash-Lite door (R8, using the just-merged FD5b injection-exposure map). These guard per-component maps a config override can never touch, so they are build-lint-only.
- A new 18-test unit file covers each of R3–R8 (a compliant chain passes, a crafted violation fails with the right reason), the lint↔validator drift guard, fail-closed behavior, and config-load rejection.

NO runtime selection change: the shipped chains already obey every R-rule, so the rejection branches are never taken; the metered doors the rules touch (Flash-Lite, Groq) are already skipped in this increment. Dev-gated / dark: the whole nature block runs only when sessions.natureRouting is enabled; unset/off is byte-identical to before (asserted). This is the guard-lints increment only — NOT the metered-door Increment B, and NOT the go-live flip.

## What to Tell Your User

This is internal plumbing for how I choose which model runs my own background checks — nothing to turn on, and nothing about our conversations changes. In plain terms: a benchmark found a handful of "never use this model for that job" rules — some cheaper models get fooled by hidden instructions when they act as a safety judge, or mangle the strict output a quick check needs. I turned those rules into build-time guards, so a future change to my settings can never quietly re-introduce one of those bad pairings. The routing feature is still off by default, so today this is invisible — it just seals those unsafe choices shut in advance.

## Summary of New Capabilities

- **R-rule exclusion guards**: build-enforced rules that keep bench-condemned model-for-job pairings out of my internal routing — a fool-able judge model off a safety-gate, an over-thinking model off a strict-format check, a doc-tree writer off the Claude door, and my message classifiers off the cheapest easily-tricked door.
- **Config-safe by construction**: an operator routing override that would re-introduce a banned pairing is rejected and falls back to the safe default, so the exclusions survive any future edit.

## Evidence

- tests/unit/nature-routing-rrule-lints.test.ts (18 tests) — green: the real authored chains + maps pass all R-rules via both the build lint and the TS validator; a crafted violation of each of R3–R8 fails with the correct reason; the lint↔validator drift guard for R3/R4/R5/R7; R6/R8 fail-closed on empty sets; config-load rejection of a violating override; and the combined validator flagging both FD4 and R-rule violations on one chain.
- npm run lint clean (the extended nature-chains lint passes on the real chains); npx tsc --noEmit clean; the pre-existing byte-identical-when-off block, A1's clamp assertion, the FD5b injection-exposure ratchet, and the FD4 harness-door ratchet all untouched and green.
