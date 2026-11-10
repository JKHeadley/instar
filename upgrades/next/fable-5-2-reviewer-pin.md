<!-- bump: patch -->
## What Changed

`claude-fable-5-2` is now an accepted explicit pin for the Claude clean-door spec reviewer (`specConverge.reviewers.anthropic.model`). It joins `claude-opus-5-5` in `CLAUDE_REVIEWER_EXPLICIT_MODELS` (`src/core/crossModelReviewer.ts`). The default reviewer pin (`claude-fable-5`) and the frontier accept-set are unchanged; nothing moves unless an operator sets the override.

## What to Tell Your User

If they asked for Fable 5.2 to review a spec and the reviewer refused the pin as not allowed, that is fixed: the spec-review step can now run on Fable 5.2 when the setting names it. Nothing changes until they ask.

## Summary of New Capabilities

- Pin the Claude spec reviewer to `claude-fable-5-2` by exact id.

## Evidence

- `tests/unit/crossModelReviewer-clean-door.test.ts`: new case accepts the explicit Fable 5.2 pin and asserts the default is still `claude-fable-5`; 31/31 green.
- The id was live-verified the same day (`claude --model claude-fable-5-2 -p`, `modelUsage` reported `claude-fable-5-2`) and is being added to the known-model list in PR #3002.
