# Side-Effects Review — FD5b: injection-exposure static map + route-resolution injection gate

**Version / slug:** `nature-axis-routing-fd5b-injection-exposure`
**Date:** `2026-07-05`
**Author:** `echo (build hand, topic 29723 routing follow-through)`
**Second-pass reviewer:** `not required (Tier 1 — deterministic static classification + a pure candidate-eligibility filter, dark/dev-gated, byte-identical no-op in Increment A; same surface + precedent as A2.1 FD4-lints #1388)`

## Summary of the change

Builds FD5b of `docs/specs/nature-axis-routing.md` (§283-294): the exhaustive, fail-safe **injection-exposure** classification the nature router consults, plus the resolve-time gate that keeps an injection-exposed component off a non-injection-safe door. Files touched:

- `src/data/llmBenchCoverage.ts` — new `LLM_ROUTING_INJECTION_EXPOSURE` map (exhaustive over `COMPONENT_CATEGORY`, `exposed` defaults true / fail-safe, each row carries the spec §371 input-shape declaration), `InjectionExposure`/`InjectionInputShape` types, and the pure `resolveInjectionExposure(component)` fail-closed resolver.
- `src/core/IntelligenceRouter.ts` — a new `isInjectionExposed` dep threaded into `resolveRoute`'s availability walk (skips a `injectionSafe:false` position when the component is exposed, reason `injectionUnsafe`), and the exported `isComponentInjectionExposed(component, perCallExposed?)` composer (static OR tighten-only per-call flag), wired at the class caller.
- `src/core/types.ts` — an OPT-IN, tightening-only `attribution.injectionExposed?: boolean`.
- Tests — NEW `tests/unit/nature-routing-injection-exposure-ratchet.test.ts` (exhaustiveness both directions, fail-safe resolve, pinned NOT-EXPOSED set + reasons, input-shape coherence, cross-check vs `LLM_UNTRUSTED_INPUT`, R8 pin) and a NEW FD5b block appended to `tests/unit/nature-routing-resolver.test.ts` (the gate + injection-cache isolation). The pre-existing byte-identical block (`nature-routing-resolver.test.ts:261-296`) and A1's clamp assertion (`:161-162`) are UNTOUCHED and green.

## Decision-point inventory

- `FD5b injection gate (resolveRoute availability walk)` — add — a PURE candidate-eligibility filter: an injection-exposed component skips a `injectionSafe:false` door. NO-OP in Increment A (the only such door, `groq-api`, is also metered → already skipped one line above).
- `LLM_ROUTING_INJECTION_EXPOSURE static classification` — add — build-time DATA (a signal), ratchet-enforced exhaustive + fail-safe; the router consults it, it holds no runtime authority of its own.
- `attribution.injectionExposed per-call flag` — add — tightening-only; can raise exposure, can NEVER relax a statically-exposed component.
- `sessions.natureRouting enable/dryRun gate` — pass-through — the whole nature block (and therefore the injection gate) still runs ONLY when enabled.

## 1. Over-block

**What legitimate inputs does this reject that it shouldn't?** In Increment A: none observable. The gate only removes a `injectionSafe:false` position for an exposed component, and the sole such position in the shipped chains (`groq-api/gpt-oss-120B`) is already unconditionally skipped as a metered door — so the resolved route is byte-identical (asserted: "the real default chains are UNAFFECTED"). The fail-safe default (unknown → exposed) could in principle skip a non-injection door for an unclassified component, but the exhaustiveness ratchet guarantees every real component is classified, so "unknown" never occurs for a shipped callsite; the fail-safe only governs a genuinely unregistered label, where skipping the non-injection door is the intended safe direction.

## 2. Under-block

**What failure modes does this still miss?** The classification is static build-time judgment — a callsite whose prompt SILENTLY starts carrying untrusted content while its row stays `exposed:false` is a semantic-drift miss. FD5b mitigates this TODAY via the ratchet cross-check against `LLM_UNTRUSTED_INPUT` (a component that becomes `untrustedInput:true` must also become `exposed:true`, or CI fails) and the input-shape coherence invariant. The full FD7 semantic-drift guard — the prompt-anchor fingerprint LINT (spec §376-384) that re-touches a row when its prompt source changes — is a SEPARATE increment the spec itself defers ("deferred to its own A/B-gated increments"); it is NOT built here. The FD4.2 R-rule lints (R4/R5/R7 injection-exposed-JUDGE bans, R8 Flash-Lite pin as a LINT) are the next increment and are not built here either.

## 3. Level-of-abstraction fit

Correct altitude. The classification lives beside its sibling axes (`LLM_UNTRUSTED_INPUT`, `LLM_ROUTING_NATURE`) in the same data module and rides the same exhaustive-ratchet pattern. The gate is a pure predicate consulted by the existing `resolveRoute` fold (the spec's own framing: "the safety/injection/allowlist/R-rule checks are candidate-eligibility FILTERS … each a pure predicate"), injected as a dep so exposure is evaluated fresh per call — not a new engine, not a new config surface. A smarter gate does not already own this; injection-exposure is intrinsic to routing and has no other home.

## 4. Signal vs authority compliance

Compliant. The injection-exposure map is deterministic build-time DATA (a signal, like the nature map), enforced by an exhaustive ratchet — it is not a brittle runtime check with blocking authority. The gate DOES exercise authority (it removes a candidate door), but only ever in the SAFE direction (toward a more-careful door / fail-closed for a critical gate), on a MODEL-ROUTING decision — it never blocks a user message, never reads or credits a principal identity, never grants anything. The per-call flag can only tighten, never relax, so a forgotten callsite cannot open a non-injection door. `docs/signal-vs-authority.md` satisfied.

## 5. Interactions

Interacts with `resolveRoute` (one skip predicate in the availability loop, placed AFTER the metered skip so the metered `groq-api` is already excluded → guaranteed no-op) and the class `evaluate()` caller (composes the per-call tighten). It does NOT shadow the FD4 harness-door clamp (orthogonal: FD4 governs the claude-code door, FD5b governs `injectionSafe:false` doors) and does not double-fire. Existing resolver tests (all exposed:true real components on default chains) are unaffected because no non-metered default door is a non-injection door. The A1 `clampClaudeCliSwapModel` degrade clamp is untouched (its assertion stays green).

## 6. External surfaces

No external surface. No new HTTP route, CLI command, MCP tool, Telegram/Slack path, or network egress. `attribution.injectionExposed` is an additive optional field — every existing caller is byte-identical (omitted ⇒ static map authoritative).

## 6b. Operator-surface quality

No operator-facing surface added or changed. The `injectionUnsafe` skip reason is an internal code comment/marker for the future FD5 structured-reason-code surface; nothing is emitted to a user yet. No secrets, tokens, or file paths surface anywhere.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, and correctly so. The injection-exposure map is static source data compiled into every machine identically; `resolveInjectionExposure` is a pure per-call function over that data with no persisted or replicated state. Each machine resolves the identical verdict for the same component independently — there is no cross-machine state to strand, replicate, or coalesce. A per-call `attribution.injectionExposed` is scoped to the single call on the machine serving it. No lease, ledger, or notice interaction.

## 8. Rollback cost

Low and clean. Revert the PR: the map + resolver + gate predicate + the optional type field drop out; `resolveRoute` returns to the pre-FD5b availability walk (which, in Increment A, produced identical routes). No migration, no persisted state, no config schema change, no data-format change. Because the gate only runs when `natureRouting.enabled` AND is a no-op over the shipped chains, a rollback is invisible to every fleet agent (feature dark) and to any dev agent in dryRun.

## Conclusion

FD5b ships the fail-safe injection-exposure classification and the resolve-time gate that structurally seals an injection-exposed call off a non-injection door — a no-op in Increment A (the one non-injection door is also metered), byte-identical when the feature is off, and dark/dev-gated. The classification is exhaustive and cross-checked against the reviewed `LLM_UNTRUSTED_INPUT` axis so it cannot silently diverge; the prompt-anchor fingerprint LINT (FD7 semantic-drift) and the FD4.2 R-rule lints are the tracked next increments, not built here.
