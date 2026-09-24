# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`KNOWN_CLAUDE_MODEL_IDS` (`src/core/ModelTierEscalation.ts`) now includes `claude-opus-5-5`, live-verified against `claude --model claude-opus-5-5 -p` on Claude Code CLI 2.1.281 (2026-09-24). Before this, a topic-profile pin or a `frameworkDefaultModels['claude-code']` value naming Opus 5.5 by exact id was refused `off-enum`; the `opus` tier alias already reached it. Recognized is not frontier: the escalation pin and frontier routing are unchanged.

## What to Tell Your User

You can now pin a conversation to Opus 5.5 by its exact name. Before, that request was turned down as an unknown model, even though the model works.

## Summary of New Capabilities

- Topics can be pinned to `claude-opus-5-5` by exact id.

## Evidence

- `tests/unit/modelTierEscalation-resolver.test.ts` and `tests/unit/topicProfileValidation.test.ts` (id accepted, stays in the subscription billing lane): 70/70. `tsc` clean. Live CLI check returned `modelUsage: ["claude-opus-5-5"]`.
