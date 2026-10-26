<!-- internal-only -->

## What Changed

Model registry cadence review (2026-10-25). The strict freshness lint (`scripts/lint-model-registry-freshness.mjs`) aged out on 2026-10-25 UTC — `lastReviewedAt` 2026-09-10 passed the 45-day window — which turned every pull request's server-side local-verify run red on the merged tree (PRs #2355 and #2356 failed on `lint-failed: lint-model-registry-freshness`, not on their own changes). This performs and records the overdue review in `scripts/model-registry-freshness.manifest.json`: `lastReviewedAt` → 2026-10-25 with a per-pin review note, and `claude-opus-5-5` + `claude-fable-5-1` added to the claude-code door's recognized frontier rows (evidence: this agent's own claude-code sessions ran on both ids that day). No pin, tier map, adapter or routing code changes; routing behaviour is identical. Promoting the Claude default/escalated tiers to the 5.5 family is an operator decision and is filed as feedback.

## Evidence

- Before: Studio `.instar/logs/local-verify.jsonl` 2026-10-26T01:31:14Z — PR 2355 `run-detail` `reasons: ["lint-failed:node scripts/lint-model-registry-freshness.mjs"]`; reproduced on a local merge of the PR with `main`: `STALENESS: model registry last reviewed 2026-09-10 (46d ago) exceeds the 45d window`.
- After: `node scripts/lint-model-registry-freshness.mjs` → `PASS — model registry pins fresh and in-allowlist`; `tests/unit/model-registry-freshness.test.ts`, `doorway-registry-reader.test.ts`, `doorway-scan-guard.test.ts` green (60 tests).
