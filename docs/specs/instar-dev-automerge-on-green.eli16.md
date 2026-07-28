# instar-dev: auto-merge on green (every tier) — Plain-English Overview

> The one-line version: once a pull request's tests all pass (green CI), the agent merges it itself — for every tier of change, not just the smallest ones — and never stops to ask the operator "should I merge this?"

## The problem in one breath

When the instar-developing agent (Echo) builds a fix, it goes through a heavy quality pipeline — a reviewed design, an independent second-pass audit, the full commit/push gates, and the complete CI test suite — before a pull request can ever go green. Yet at that final green moment the agent was pausing to ask the operator "ready to merge?" every single time. That pause is wasted ceremony: by the time everything is green, the change has already been proven mergeable. The operator asked, directly, to stop doing it — and to fix it structurally so it can't come back.

## What already exists

- **The instar-dev skill** — the six-phase process every change to instar's own source goes through (spec → principle check → plan → build → side-effects review → trace+commit). It already documented that small "Tier-1" changes auto-merge on green.
- **`scripts/safe-merge.mjs`** — a merge wrapper that waits for every check to finish, refuses to merge if anything is red (and specifically confirms the end-to-end test job ran and passed), then merges. It's the safe way to merge even a branch that's a little behind.
- **CI + branch protection** — the authoritative green/red verdict on every PR.

## What this adds

A new final phase to the instar-dev skill — **Phase 7: Auto-merge on green** — that makes auto-merge the rule for **every tier**, not just Tier-1, and explicitly forbids pausing to ask the operator to merge a green PR. The merge is done by the existing `safe-merge.mjs` wrapper (so the safety check is preserved), and the agent narrates the ship afterward instead of asking for permission before.

## The new pieces

- **Phase 7 in the skill** — "green CI = mergeable, full stop." It names the one thing that stops a merge (a real red check on this change → fix and re-run) and the thing that does not (an unrelated flaky test → re-run, never ask).
- A small correction to the Tier-1 description so it no longer reads as if auto-merge is a Tier-1-only privilege.

## The safeguards

**Nothing unsafe gets merged.** Auto-merge runs *only* after CI is fully green, through the wrapper that re-checks every job (including end-to-end) and refuses on any red. The quality gates that earn the green — reviewed design, second-pass audit, commit/push gates, full CI — are all unchanged; this only removes a redundant human pause at the very end.

**A real failure still stops everything.** If a check fails on the change itself, the agent fixes it and re-runs — it does not merge. Only a genuinely-green PR merges.

## What ships when

One small pull request to instar's own source (a skill-documentation change). It governs how the instar-developing agent behaves on every future PR. It will itself be auto-merged on green — eating its own dogfood.

## What you actually need to decide

Do you approve making auto-merge-on-green the standing rule for every tier of instar-dev change (via a new Phase 7 in the skill), so the agent stops asking you to merge green PRs and just lands them?
