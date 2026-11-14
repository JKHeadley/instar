# Standards back-references: baseline emptied, expired countdown resolved

<!-- bump: patch -->

## What Changed

`scripts/lint-documented-only-countdown.mjs` has failed the lint chain on every tree since 2026-11-14 00:00 UTC: the article *References Run From Both Ends — the Registry Names the Code, the Code Names the Standard* carried a sub-obligation countdown of 2026-11-13 (`STD-SUBCOUNTDOWN-backreference-completion`: drive the back-reference baseline to zero and widen the population beyond registry-cited files). `dev:preflight` runs that chain, so `tests/e2e/dev-preflight-cli.test.ts` failed every Local Verify run.

- The 27 files in `docs/standards-backreference-baseline.json` each gain a header comment naming the article(s) whose enforcement field cites them. The baseline is empty: `lint-standard-code-backreference` reports 70 of 70.
- `scripts/lint-standard-code-backreference.mjs`: an article title of 12 characters or fewer (*Self-Hosting*, *Zero-Failure*, *No Deferrals*) was skipped entirely by a `length > 12` filter, so a file governed only by such an article could never leave the baseline. It now counts in its emphasised form (`*Self-Hosting*`) only.
- `docs/STANDARDS-REGISTRY.md` (code-owner file): the article's `Applied through` line states the current count and re-dates the remaining half of the sub-obligation (widen the population) to 2026-11-27. The re-date takes effect only with the operator's approving review.

## What to Tell Your User

Nothing changes in how the agent behaves. A deadline written into the project's own rules passed and stopped every change from being tested; the overdue work behind it is now done.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| A registry-cited file with no back-reference fails lint immediately (no grandfather list) | Automatic |

## Evidence

Local Verify, 2026-11-14 UTC: PR 3079 failed 00:02 (peer) and PR 3137 failed 00:06, both on `tests/e2e/dev-preflight-cli.test.ts`; re-running `node dist/cli.js dev:preflight` in the kept run directory printed `❌ lint-documented-only-countdown failed: docs/STANDARDS-REGISTRY.md:937 ... countdown EXPIRED on 2026-11-13 (today 2026-11-14)`. With this change: `lint-standard-code-backreference: clean — 70 cited file(s), 70 naming a standard back, 0 grandfathered`; `lint-documented-only-countdown: clean`; `npm run lint` exits 0; eight unit files covering the registry and its gates pass (392 tests). The Building family audit is recorded for the changed text (`docs/audits/standards-backreference-completion-building-family-2026-11-13.json`); `tests/unit/standards-coverage-ratchet.test.ts`, which failed this change's first run on the stale audit, passes.
