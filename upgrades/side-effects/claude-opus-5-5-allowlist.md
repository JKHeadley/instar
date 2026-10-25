# Side-Effects Review — claude-opus-5-5 in the claude-code allowlist

**Version / slug:** `claude-opus-5-5-allowlist`
**Date:** `2026-09-24`
**Author:** Echo
**Tier:** 1 (4 LOC, 1 source file, risk floor 1)

## Summary of the change

One string, `claude-opus-5-5`, is added to `KNOWN_CLAUDE_MODEL_IDS` in `src/core/ModelTierEscalation.ts`, with test assertions in `tests/unit/modelTierEscalation-resolver.test.ts` and `tests/unit/topicProfileValidation.test.ts`. The id was live-verified with `claude --model claude-opus-5-5 -p` on CLI 2.1.281 (modelUsage reported `claude-opus-5-5`).

## Decision-point inventory

- **Modified:** the model-id acceptance enum. It is an existing invariant-style allowlist, now accepting one more live-verified id. No new judgment, gate, default or authority.

## 1. Over-block

This change removes an over-block: a valid topic pin or `frameworkDefaultModels` value naming Opus 5.5 was refused `off-enum`. No new legitimate input is rejected.

## 2. Under-block

No issue identified. The enum still refuses every unverified id, including plausible siblings. A typo of the new id is still refused.

## 3. Level-of-abstraction fit

This is the right layer. The enum is the single acceptance list that validation, resolution and the spawn route already consult. No parallel list is added.

## 4. Signal vs authority compliance

Compliant. The enum is a deterministic invariant over a closed set of verified names, not brittle judgment. Adding a verified member does not create or widen any blocking authority.

## 5. Interactions

The billing-lane check keeps it inside the subscription lane, and a test asserts `billingLaneError` is null. Frontier lists, the doorway manifest, the escalated tier pin (`claude-fable-5`) and default models are unchanged, so routing does not shift. Recognized is not frontier.

## 6. External surfaces

Operators can now pin a topic to `claude-opus-5-5` by exact id. Nothing else visible changes. It relies on the Claude CLI serving that id, which was verified live. If the CLI later withdraws it, the existing fallback-with-notice path applies.

## 7. Multi-machine posture

Machine-local by design, as code. Each machine enforces the same enum from its installed version. During a rolling update, a pin replicated from an updated machine to an older one falls back to defaults with the existing notice until that machine updates. It never blocks and never strands state.

## 8. Rollback cost

Revert the one line in a patch release. Existing exact-id pins then fall back to defaults with the existing notice. No data migration and no agent state repair.
