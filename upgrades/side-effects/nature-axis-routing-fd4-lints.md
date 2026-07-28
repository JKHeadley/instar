# Side-Effects Review — FD4 harness-door ban: enforcement lints (build-lint + resolve-time/config-load validator)

**Version / slug:** `nature-axis-routing-fd4-lints`
**Date:** `2026-07-04`
**Author:** `echo (build hand, 24h autonomous run, topic 29723)`
**Second-pass reviewer:** `not required (Tier 1 — deterministic, dark/dev-gated, byte-identical when off)`

## Summary of the change

Completes the FD4 "harness-door ban" from `docs/specs/nature-axis-routing.md` by adding the two enforcement places that were still prose (the third place — the always-on runtime clamp — already shipped in A1 #1386 / A2.1 #1387). Files touched: `src/core/IntelligenceRouter.ts` (pure validator predicate `validateNatureRoutingChains`/`validateChainPosition`/`isNatureRoutingChainsValid` + wiring into `mergeNatureRoutingChains` config-load and `resolveRoute` resolve-time + a deduped rejection warning), `scripts/lint-nature-chains.mjs` (new build-lint), `package.json` (wire the lint into `npm run lint` + a `lint:nature-chains` alias), and two unit test files (`tests/unit/llm-routing-nature-ratchet.test.ts`, `tests/unit/nature-routing-resolver.test.ts`). The change interacts with the nature-axis routing decision surface only; it adds NO new routing behavior when the feature is off.

## Decision-point inventory

- `FD4 harness-door ban (compile-time place)` — add — the build-lint `lint-nature-chains.mjs` fails the build on a banned authored chain position.
- `FD4.3 resolve-time / config-load validator` — add — the pure predicate that rejects a banned live chain → built-in defaults + warn-once, consulted in `resolveRoute` and `mergeNatureRoutingChains`.
- `FD4 place-3 runtime clamp (clampToReserveOnCleanDoor / clampClaudeCliSwapModel)` — pass-through — unchanged; the new validator is belt-and-suspenders ahead of it.
- `sessions.natureRouting enable/dryRun gate` — pass-through — the whole nature block (and therefore the new validator) still runs ONLY when enabled.

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The build-lint could in principle reject a legitimate authored chain. It does not: the registry-pinned `balanced` label on claude-code (which resolves to the concrete reserve id) is accepted in FAST/SORT/JUDGE, the literal concrete reserve id is accepted, WRITE's `capable`/`fast` (Opus/Haiku) are accepted, and clean non-claude-code doors (incl. the openrouter Opus API door) are accepted. Verified: the real authored v3 defaults pass with zero violations (positive ratchet test). The runtime validator only rejects a chain that violates the static ban, and it falls back to the built-in defaults rather than failing the call, so a rejected operator override degrades to the safe default, never to a hard denial.

## 2. Under-block

**What failure modes does this still miss?**

The lint's model-id resolution is scoped to `ROUTING_LABEL_TO_MODEL_ID` + a literal Fable substring scan — it does not follow a claude-code *tier label* through the downstream per-adapter tier map (e.g. `frameworkDefaultModels.claude-code`). That is deliberate: the claude-code FAST/SORT/JUDGE allowlist forces the pinned reserve id regardless, and WRITE tier resolution is the FD8 companion config concern (a tracked, restart-gated remainder), not this slice. The FD4.2 R-rule lints (R3–R8: doc-tree Claude-ban, Flash-Lite pin, injection-exposed JUDGE bans) are NOT built here — they depend on an injection-exposure map that does not yet exist; tracked as a remainder.

## 3. Level-of-abstraction fit

The validator is a pure, side-effect-free predicate over the static chain data (mirrors `validateChainPosition`), placed beside the existing FD4 functions in `IntelligenceRouter.ts`. The build-lint follows the house pattern (`lint-routing-registry-freshness.js` / `lint-no-opus-claude-cli-gating.js`): read source text pre-compile, export a pure function, exit 1 on violation. Correct altitude — no new engine, no new config language.

## 4. Signal vs authority compliance

The build-lint is a CI gate (a build ratchet — its natural authority is to fail the build on a real violation; the authored defaults are clean so it passes today). The resolve-time/config-load validator does exercise authority — it REJECTS a banned chain → built-in defaults — but this is a safety clamp on a MODEL-ROUTING decision, not a principal/operator authority decision: it never blocks a user message, never grants or credits anyone, and only ever narrows toward the sanctioned-safe default (the same safe direction as the existing runtime clamp). It emits a deduped warn-once so the rejection is never silent. No principal identity is read or asserted anywhere.

## 5. Interactions

Interacts with `resolveRoute` (adds a validation step before the availability walk) and `mergeNatureRoutingChains` (rejects a banned override chain at load). Both run only under `natureRouting.enabled`. Existing resolver tests (which pass valid default chains / valid overrides) are unaffected — validation returns empty and the positions are unchanged. The place-3 clamp still runs downstream; the two layers coexist as designed (three-place enforcement). The A1 `clampClaudeCliSwapModel` degrade-path clamp is untouched (its byte-identical-when-off behavior is preserved).

## 6. External surfaces

No external surface. No new HTTP route, no CLI command, no MCP tool, no Telegram/Slack path, no network egress. The build-lint reads a local source file; the validator reads in-memory config already loaded by the router.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator-facing surface added or changed. The warn-once rejection message names the offending chain + the human-readable violation detail (which position, which rule, the sanctioned reserve id) so an operator who mis-edits a chain via `PATCH /config` sees exactly why it was rejected. No raw secrets, tokens, or file paths are emitted.

## 7. Multi-machine posture (Cross-Machine Coherence)

No cross-machine state. The validator is a pure function over per-call config; the build-lint is a repo build gate. The chain config is read live per call on each machine independently (existing `resolveConfig()` behavior). No replication, no shared ledger, no lease interaction. A per-machine operator override that is banned is rejected identically and independently on each machine.

## 8. Rollback cost

Low and clean. Revert the PR: the build-lint line drops out of `npm run lint`, the validator functions are removed, and `resolveRoute`/`mergeNatureRoutingChains` return to passing chains through unvalidated (the place-3 runtime clamp still guarantees safety). No migration, no persisted state, no config schema change, no data-format change. Because the validator only runs when `natureRouting.enabled`, a rollback is invisible to every fleet agent (feature dark).

## Conclusion

A deterministic, dark/dev-gated, byte-identical-when-off hardening slice that closes two of the three FD4 enforcement places. No block/allow surface on user traffic, no external surface, no multi-machine state, trivial rollback. Tier 1.

## Second-pass review (if required)

Not required — Tier 1 (deterministic enforcement lints; byte-identical when off; no operator/user-facing surface). Full `npm run lint` green and both affected test files green (54 tests) at authoring time.

## Evidence pointers

- `scripts/lint-nature-chains.mjs` runs clean over the real chain map (`lint-nature-chains: OK`).
- `tests/unit/llm-routing-nature-ratchet.test.ts` — positive (real chains pass) + negative (Opus / tier-label / Fable fail) + drift guard (lint predicate agrees with the TS validator).
- `tests/unit/nature-routing-resolver.test.ts` — validator both-sides, config-load rejection, resolve-time rejection, and byte-identical-when-off with a banned override present.

## Class-Closure Declaration (display-only mirror)

This closes the compile-time + resolve-time/config-load places of the FD4 ban as a class over the whole chain map (all four chains, every position), not a single spot fix. Tracked remainders (out of this slice by design): the FD4.2 R-rule lints (need the injection-exposure map), the full FD6 aggregated attention-item on rejection (warn-once here), and the FD8 `frameworkDefaultModels` companion config change (restart-gated).
