# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The spec-review helper (`skills/spec-converge/scripts/cross-model-review.mjs`) no longer loads an out-of-date built copy of the reviewer, and a model the account refuses is now reported as exactly that.

- **The agent's own install is always on the list.** Run from an agent's own skills folder, the helper never looked in that agent's install, so an old build left in the agent's home folder was the only copy it found. It now looks there second.
- **Out-of-date built copies are passed over.** The helper looks for the built reviewer module in a fixed order and used to take the first one that existed. On one machine that was an old, untracked `dist/` folder in the agent's home folder whose model table still named a retired GPT model, so every GPT review degraded. Now a built copy with no instar `package.json` beside it, or a checkout build older than the reviewer's source files, is skipped and the next copy is used. If nothing else exists it is still loaded (the review never blocks), and the output says `moduleStale: true`.
- **The output names what it loaded and what it skipped,** on every run, not only `--detect-only`: `resolvedModulePath`, plus `moduleSkipped` with a reason (`orphan-build` or `stale-build`) for each copy passed over.
- **A refused model has its own reason.** When the ChatGPT-account Codex surface refuses the requested model, the review now degrades with `model-unsupported` (the flag names the refused model) instead of the generic `error`.

## What to Tell Your User

Nothing changes for you. Your agent's outside design reviews stop failing quietly when an old copy of the reviewer is lying around, and when a model is refused the agent can see why.

## Summary of New Capabilities

- Review helper output fields `moduleSkipped` and `moduleStale`, and `resolvedModulePath` on full runs.
- Review failure reason `model-unsupported`.

## Evidence

- Unit: the module freshness ladder on real folder layouts, including a copy of the real script placed in the failing machine's folder layout (`tests/unit/cross-model-review-module-freshness.test.ts`), and the new failure class with the adapter's exact refusal wording (`tests/unit/crossModelReviewer.test.ts`).
