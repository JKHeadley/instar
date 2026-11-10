<!-- bump: patch -->
## What Changed

`claude-fable-5-2` is now a known claude-code model id. It was live-verified against the Claude Code CLI (2.1.319; the call reported `modelUsage: claude-fable-5-2`) and added to the acceptance list in `src/core/ModelTierEscalation.ts` and, as a recognized-not-promoted row, to the model registry manifest. Topics can be pinned to it and the escalation target can name it. No lane, pin or default moves on its own.

## What to Tell Your User

If they asked for Fable 5.2 and were told it was not a known model, that is fixed: you can now pin a topic or the step-up setting to Fable 5.2. Nothing changes until they ask.

## Summary of New Capabilities

- Pin a topic, or the model-tier escalation target, to `claude-fable-5-2`.

## Evidence

- `tests/unit/topicProfileValidation.test.ts`, `tests/unit/modelTierEscalation-resolver.test.ts`, `tests/unit/dashboard-door-model-display.test.ts`, `tests/unit/modelSwapService.test.ts` green with the new id.
- `scripts/lint-model-registry-freshness.mjs` passes (frontier set unchanged, review date within window).
