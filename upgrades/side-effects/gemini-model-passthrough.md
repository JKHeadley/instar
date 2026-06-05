# Side Effects — Gemini Explicit Model Passthrough

## Change Summary

`resolveModelForFramework('gemini-cli', model)` now passes unrecognized explicit Gemini model ids through instead of replacing them with the default flash model. Generic tiers and legacy Claude tier aliases still map to the verified Gemini tier choices. Gemini capacity fallback remains constrained by `resolveKnownGeminiFallback`.

## Signal vs Authority

This change does not add a detector or blocking authority. It changes deterministic model-string resolution before a framework CLI spawn. The relevant decision boundary is caller intent: explicit model ids are honored, while automatic fallback selection remains constrained by the existing capacity-policy helper.

## Over-Block

No legitimate explicit Gemini model id is blocked by this change. The previous behavior overrode unrecognized ids; this change removes that over-block.

## Under-Block

An invalid explicit Gemini model id can now reach the Gemini CLI and fail there. That is intentional: live CLI probes for Claude, Codex, and Gemini all showed explicit bogus model ids fail loudly at the provider/CLI boundary rather than defaulting silently.

## Level Of Abstraction

The change belongs in `frameworkSessionLaunch` because that helper owns framework-specific model translation for interactive and headless session spawns. The Gemini adapter resolver already had the correct pass-through contract; this brings the session-launch resolver back into alignment.

## Interactions

The capacity policy is not weakened. Its automatic fallback path still uses the known-model constraint, so guessed fallback choices remain bounded to verified Gemini models. The changed path only applies to explicit launch model input.

## External Surfaces

Gemini sessions launched with an explicit new or experimental model id will now actually pass that id to Gemini. If the id is unavailable, the session fails with the CLI/provider error instead of silently running the default model.

## Rollback

Rollback is a one-line revert in `resolveModelForFramework('gemini-cli', ...)`, plus reverting the added tests. No data migration or state repair is required.

## Evidence

Grounding:
- PR #708 review established the principle: respect explicit caller intent; constrain only automatic or guessed fallback choices.
- Current `resolveCliModelFlag` for Gemini already passes explicit raw model ids through.
- Live bogus-model probes: Claude and Codex both surfaced explicit model errors; Gemini package-runner surfaced `ModelNotFoundError`.

Validation:
- `npx vitest run tests/unit/frameworkSessionLaunch.test.ts tests/unit/gemini-cli-adapter.test.ts tests/unit/geminiCapacityPolicy.test.ts tests/unit/codex-model-tier-resolution.test.ts` — 91/91 passed.
