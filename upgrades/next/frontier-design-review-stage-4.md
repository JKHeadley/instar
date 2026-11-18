<!-- bump: patch -->
## What Changed

Stage 4 (repository part) of the frontier design and review standard (`docs/specs/frontier-design-review-standard.md`).

- New agent awareness entry: start design work as its own session (`workKind: design`), run `/design-review` (or `/spec-converge` for Instar specs) before asking approval of any plan, carry the review line from `GET /design/review`, and tell the operator the reference is a lookup key.
- `/spec-converge` gains step 3, one recording driver run per round (`--all --record`), reaching existing agents through a marker-keyed migration that skips customised copies.
- The driver's `--all` output now includes each reviewer's findings.

## What to Tell Your User

Your agent now knows to write plans in their own session on the strongest model and to have every plan reviewed before asking for your approval, and its review skill records each round. Nothing for you to do.

## Summary of New Capabilities

- Awareness for the design standard; `/spec-converge` recording step; reviewer findings in the driver output.

## Evidence

- Unit: `tests/unit/PostUpdateMigrator-recordingDriverRun.test.ts`, `tests/unit/awareness-entry-registry.test.ts`, `tests/unit/designReviewRun.test.ts`.
