# Side-Effects Review — LA4 unconditional degrade-path safety clamp (S4 Increment A1)

**Spec:** docs/specs/nature-axis-routing.md (status: **converged — pending operator approval** — NOT yet
approved; this ships as a **Tier-1** standalone safety narrowing, the smallest independently-landable
unit the spec's FD9 defines as **A1**). **Parent standards:** "Structure > Willpower", "No Silent
Degradation to Brittle Fallback", benchmark-cited routing (INSTAR-Bench v3, rules R1/R2).
**Not dark-gated:** A1 is UNCONDITIONAL by design — it fires regardless of `sessions.natureRouting`.
**Files:** src/core/IntelligenceRouter.ts, tests/unit/la4-degrade-path-clamp.test.ts,
docs/specs/nature-axis-routing.md (+ .eli16.md + reports/nature-axis-routing-convergence.md — the
converged spec docs riding to main), upgrades/la4-degrade-clamp-a1.eli16.md,
upgrades/side-effects/la4-degrade-clamp-a1.md, upgrades/next/la4-degrade-clamp-a1.md.

## What changed

1. **IntelligenceRouter.ts — the degrade-to-default path (`evaluate()`, the `if (!primary)` block).**
   The shipped router degrades a binary-missing routed framework to
   `defaultProvider.evaluate(prompt, options)` UNCLAMPED. When `defaultFramework === 'claude-code'` and
   `options.model === 'capable'`, that landing is Opus-via-Claude-CLI — the measured-banned route for a
   bounded/gating verdict (99.1% clean-API vs 81.7% via the CLI; emergency-stop 73%). The merged S2 clamp
   (`clampClaudeCliSwapModel`) only guarded the failure-swap LOOP, leaving this exit open (the spec's LA4
   fail-open). A1 clamps this exit: for a bounded/gating call, `options.model` is passed through
   `clampClaudeCliSwapModel(defaultFramework, options.model)` (the SAME `capable→balanced` reserve S2
   uses), and a distinct `degrade-path-model-clamp (LA4)` degrade note is emitted.
2. **Two new exported pure helpers** in the same module: `routingNatureFor(component)` (a read-only lookup
   of the merged S1 `LLM_ROUTING_NATURE` map with the same per-operation "/segment" + `server:` key
   handling `categoryForComponent` uses) and `isBoundedGatingDegrade(component, options)` — the FD4/CR6-3
   predicate: TRUE iff `attribution.gating === true` OR the component maps to a non-`WRITE` chain. A
   `WRITE`-chain component (its legitimate Opus-CLI quality lane) or an unmapped, non-gating call ⇒ FALSE
   (left unchanged).
3. **Spec docs ride to main** (same pattern as reviewer-door inc1): the converged nature-axis-routing spec
   + its ELI16 + convergence report, with `status: "converged — pending operator approval"` and the
   `review-convergence` tag preserved AS-IS (no `approved: true` — that is the operator's step).

## Blast radius

- **The clamp only ever NARROWS.** `clampClaudeCliSwapModel` returns `capable→balanced` only for
  `claude-code`; every other door and every non-`capable` tier passes through unchanged. It never upgrades
  a tier, never blocks a call, never touches WRITE.
- **Scope is exactly R1/R2.** `isBoundedGatingDegrade` fires only for a mapped non-WRITE nature or an
  explicit `attribution.gating` flag. An unmapped, non-gating degrade (the common "other" category) is
  left byte-identical. A non-`claude-code` default door is never clamped (Opus-via-API is fine).
- **No new config, no new route, no state.** Two pure functions + a few lines on an existing branch. The
  static map read is O(1) and always available, so the predicate never depends on `natureRouting` being
  set — which is what makes the clamp genuinely unconditional.
- **Honest non-byte-identical deviation.** This is the ONE deliberate behavior change on the degrade path:
  a binary-missing bounded/gating `capable` degrade with a `claude-code` default now yields Sonnet-CLI
  instead of Opus-CLI. Strictly the safe direction (measured-worse route → sanctioned reserve). Every
  other path is untouched.

## Risk + mitigation

- **Risk:** the clamp over-reaches and downgrades a legitimate Opus-CLI WRITE call. **Mitigation:**
  `isBoundedGatingDegrade` keys on `chain !== 'WRITE'`; a WRITE component is exempt. Proven by a property
  test over the whole `LLM_ROUTING_NATURE` map (predicate === `chain !== 'WRITE'` for every mapped row).
- **Risk:** the clamp silently fails to fire when the feature is off (the exact fleet-default state where
  the fail-open lives). **Mitigation:** the predicate reads only the static map + `attribution`, never
  `natureRouting`; a test asserts the clamp fires with `natureRouting` UNSET, and separately that a
  non-`claude-code` default is left alone (both-default-framework arms).
- **Risk:** collateral change to unrelated calls. **Mitigation:** unmapped, non-gating degrade test
  asserts `model` is passed through untouched (`capable` stays `capable`).

## Framework generality

Not applicable to the session-launch/inject abstraction (this touches the internal LLM router only). The
clamp is keyed on the `claude-code` DOOR specifically because that door carries the measured harness
penalty; codex-cli / gemini-cli / pi-cli defaults are correctly never clamped (Opus-via-those-doors is
not the banned route). This is framework-correct, not a Claude-only assumption.

## Tests

`tests/unit/la4-degrade-path-clamp.test.ts` (13 cases): `routingNatureFor` key handling; the
`isBoundedGatingDegrade` predicate incl. the whole-map property test; and the load-bearing `evaluate()`
integration — the clamp fires on a bounded/gating degrade with `natureRouting` unset, fires on a
gating-flagged unmapped call, does NOT over-clamp an unmapped non-gating call, does NOT clamp a
non-`claude-code` default, and leaves a non-`capable` tier alone. Existing
`opus-claude-cli-gating-guardrail.test.ts` (14) + `intelligence-router.test.ts` (17) +
`provider-fallback-swap-timeout.test.ts` (11) stay green; `tsc` clean.
