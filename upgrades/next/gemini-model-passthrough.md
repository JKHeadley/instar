# Gemini Explicit Model Passthrough

<!-- bump: patch -->

## What Changed

Gemini session launch model resolution now honors explicit raw Gemini model ids. Generic tiers still map to verified Gemini defaults, but unrecognized explicit names pass through to the Gemini CLI instead of being silently replaced with the flash default.

## What to Tell Your User

If someone deliberately configures a newer or experimental Gemini model, I now try exactly that model. If the model name is wrong or unavailable, Gemini reports the real error instead of quietly running a different default model.

## Summary of New Capabilities

- Explicit Gemini model overrides are honored in interactive and headless session launches.
- Automatic Gemini capacity fallback remains constrained to verified known models.
- Regression tests now assert raw Gemini model ids reach the spawned CLI arguments.

## Evidence

Grounded against PR #708's review boundary and live CLI probes: Claude, Codex, and Gemini all fail loudly when given a bogus explicit model id. Focused validation: `npx vitest run tests/unit/frameworkSessionLaunch.test.ts tests/unit/gemini-cli-adapter.test.ts tests/unit/geminiCapacityPolicy.test.ts tests/unit/codex-model-tier-resolution.test.ts` passed, 91/91 tests.
