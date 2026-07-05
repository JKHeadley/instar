# Side-Effects Review — FD4.2: R-rule structural-exclusion lints (R3–R8)

**Version / slug:** `nature-axis-routing-fd42-rrule-lints`
**Date:** `2026-07-05`
**Author:** `echo (build hand, topic 29723 routing follow-through)`
**Second-pass reviewer:** `not required (Tier 1 — deterministic static structural exclusions over authored config data + pure candidate-eligibility predicates, dark/dev-gated, byte-identical no-op over the shipped chains; same surface + precedent as the FD4-lints #1388 and FD5b #1393)`

## Summary of the change

Builds FD4.2 of `docs/specs/nature-axis-routing.md` (§296-314): the R-rule structural exclusions R3–R8 over the (still-dark) nature router's authored chains and per-component maps. Files touched:

- `src/data/llmBenchCoverage.ts` — two new component sets: `NATURE_ROUTING_CLAUDE_BANNED_COMPONENTS` (R6, doc-tree/cartographer) and `NATURE_ROUTING_INPUT_CLASSIFIER_COMPONENTS` (R8, the input-classifier pins).
- `src/core/IntelligenceRouter.ts` — the pure R-rule POSITION-ban predicate `validateChainPositionRRule` (R3/R4/R5/R7) + `validateNatureRoutingChainRRules` + a combined `validateNatureRoutingChainAll`; the `NatureChainBanRule` union extended with the four R-rule tags; the combined validator wired into both `resolveRoute`'s chain-rejection and `mergeNatureRoutingChains`'s config-load rejection alongside the existing FD4 ban.
- `scripts/lint-nature-chains.mjs` — the build lint extended with R3–R8: `rruleViolationForPosition` (mirrors the TS predicate), source-parsing helpers (`extractStringSet`/`extractNatureMap`/`extractExposureMap`), `r6Violations`/`r8Violations`, and `runNatureRuleLints`; `main()` now fails the build on any FD4 OR R-rule violation.
- Tests — NEW `tests/unit/nature-routing-rrule-lints.test.ts` (18 tests: real chains pass all R-rules via both lint + TS validator; a crafted violation of each of R3–R8 fails with the right reason; the lint↔validator drift guard for R3/R4/R5/R7; R6/R8 fail-closed on empty sets; config-load rejection of a violating override; the combined validator flagging both FD4 and R-rule violations). The pre-existing byte-identical block (`nature-routing-resolver.test.ts:261-296`), A1's clamp assertion, the FD5b ratchet, and the FD4 harness-door ratchet are UNTOUCHED and green.

## Decision-point inventory

- `FD4.2 R-rule position bans (R3/R4/R5/R7)` — add — pure candidate-eligibility predicates over authored chains; a violating chain is rejected → built-in default (same mechanism as the FD4 ban). NO-OP over the shipped chains (already clean).
- `FD4.2 R6/R8 component-map pins` — add — build-lint-only structural assertions over per-component maps that a config override can never touch.
- `resolveRoute chain-rejection` — modify — now runs FD4 + R-rule violations via `validateNatureRoutingChainAll`. Byte-identical for a clean chain (rejection branch untaken).
- `mergeNatureRoutingChains config-load` — modify — rejects an operator override that violates FD4 OR an R-rule → built-in default + notice.
- `sessions.natureRouting enable/dryRun gate` — pass-through — the whole nature block still runs ONLY when enabled.

## 1. Over-block

**What legitimate inputs does this reject that it shouldn't?** Over the shipped chains: none. Every default position passes all R-rules (asserted: "the REAL authored chain map + maps pass ALL R-rule lints"), so no route is removed and no chain is rejected. The rules only reject a chain that PLACES a bench-condemned model in an unsafe slot — a placement no legitimate config authors. R3's model match is `qwen`, R5's is `gpt-oss-20b|llama-4-scout`, R7's is `deepseek` — narrow, bench-cited denylist terms that appear in no shipped or plausible-safe chain; R4 bans only the `gemini-cli` DOOR from the JUDGE chain. False-positive surface is effectively nil.

## 2. Under-block

**What failure modes does this still miss?** The R-rule set is exactly the spec's R3–R8 — it does not attempt to catch every conceivable bad placement, only the bench-condemned classes. R6 is a structural pin that is vacuously satisfied today (the cartographer component has no nature/chain yet), so it guards against a FUTURE edit rather than fixing a present defect — that is by design (the spec's "makes their exclusion structural so a future edit can't reintroduce them"). R8's flash-lite guarantee is realized by asserting flash-lite stays behind the metered gate (unreachable in Increment A) rather than a per-component resolve-time skip — the per-component walk-skip would be a SELECTION change, which this increment deliberately does not make (out of scope; the metered-skip already delivers the same runtime guarantee in Increment A). The FD7 prompt-anchor semantic-drift lint remains a separate deferred increment.

## 3. Level-of-abstraction fit

Correct altitude. The R-rule predicates live beside the FD4 ban predicate in `IntelligenceRouter.ts` and ride the identical shape (`NatureChainViolation`, per-position → per-chain → all-chains) and the identical config-load/resolve wiring. The build lint extends the existing `lint-nature-chains.mjs` (the spec's named home for the compile-time place). The two component sets sit beside `NATURE_ROUTING_CRITICAL_GATES` in the same data module. No new engine, config surface, or route.

## 4. Signal vs authority compliance

Compliant. The R-rule maps/predicates are deterministic build-time DATA + pure predicates (signals), enforced by a lint ratchet — not brittle runtime checks with blocking authority. The resolve/config-load rejection DOES exercise authority (it discards a violating chain → safe default), but only ever in the SAFE direction, on a MODEL-ROUTING decision — it never blocks a user message, never reads or credits a principal, never grants anything. `docs/signal-vs-authority.md` satisfied.

## 5. Interactions

Interacts with the FD4 ban (orthogonal and composable: `validateNatureRoutingChainAll` = FD4 violations ∪ R-rule violations; a drift-guard/combined test proves both surface independently on one chain). Placed alongside — never shadowing — FD4; the two target different unsafe placements (FD4 = the claude-code harness door; R3/R4/R5/R7 = qwen/gemini-cli/weak-gate/deepseek by chain). The resolver's existing FD5b injection gate and A1 clamp are untouched (their tests stay green). The build lint's new source-parsing reads the same `llmBenchCoverage.ts` the FD4 lint already parses.

## 6. External surfaces

No external surface. No new HTTP route, CLI command, MCP tool, Telegram/Slack path, or network egress. The lint is a `npm run lint` step (already wired for FD4). No secrets, tokens, or file paths surface anywhere.

## 6b. Operator-surface quality

No operator-facing surface added or changed. The rejection "notice" path is the pre-existing FD4 `onInvalidChain`/`onReject` callback (internal); nothing new is emitted to a user.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, and correctly so. The R-rule predicates and maps are static source data compiled into every machine identically; the validators are pure functions over that data with no persisted or replicated state. Each machine resolves the identical verdict independently — there is no cross-machine state to strand, replicate, or coalesce. No lease, ledger, or notice interaction.

## 8. Rollback cost

Low and clean. Revert the PR: the two component sets, the R-rule predicates, and the two wiring call sites (reverting `validateNatureRoutingChainAll` back to `validateNatureRoutingChain`) drop out; the lint returns to FD4-only. No migration, no persisted state, no config schema change, no data-format change. Because the R-rules are a no-op over the shipped chains and only run when `natureRouting.enabled`, a rollback is invisible to every fleet agent (feature dark) and to any dev agent in dryRun.

## Conclusion

FD4.2 ships the R3–R8 structural exclusions as a build lint (extended `lint-nature-chains.mjs`, wired into `npm run lint`) plus resolve-time/config-load rejection for the position bans (R3/R4/R5/R7) mirroring the FD4 ban, and build-lint pins for the component-scoped rules (R6/R8). It changes no runtime selection (the shipped chains are clean; the metered doors it touches are already skipped in Increment A), is byte-identical when the feature is off, and is dark/dev-gated. R8 consumes the just-merged FD5b injection-exposure map. The FD7 prompt-anchor semantic-drift lint and the metered-door Increment B are the tracked next increments, not built here; the spec is NOT marked approved by this change.
