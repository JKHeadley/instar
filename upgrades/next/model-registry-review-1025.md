# Model registry review: every pinned model re-verified

## What Changed

- `scripts/model-registry-freshness.manifest.json`: the 45-day staleness check had expired (last review 2026-09-10) and was refusing every commit. Every pinned id and frontier model answered a live prompt on its own door today; `lastReviewedAt` is now 2026-10-25, with the evidence in `$lastReviewNote`. claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-fable-5-1 and gemini-4-argon are recorded as recognized (`frontier: false`). No pin or routing change.

## What to Tell Your User

Nothing changes for you: this is a routine check that the AI models I rely on are all still available. They are.

## Summary of New Capabilities

None — maintenance.

## Evidence

Live one-line prompts on 2026-10-25 answered "ok" from each pinned model on claude -p, codex exec and the gemini CLI; `node scripts/lint-model-registry-freshness.mjs` → PASS.
