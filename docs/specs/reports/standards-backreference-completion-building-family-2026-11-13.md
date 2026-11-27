# Building family review — back-reference baseline emptied, sub-obligation re-dated (2026-11-13)

## What changed in the Building family

One article, one line: *References Run From Both Ends — the Registry Names the Code, the Code Names the Standard*, its `**Applied through.**` field.

- The statement of current state changes from "23 of 50 cited files carry a back-reference; 27 do not" to "all 70 cited files carry a back-reference; the baseline is empty (2026-11-13)", with the limit of that claim stated: each back-reference was written from the registry's own enforcement citation, and asserts that the citation exists in both directions, not that it is the right one.
- A sentence records the lint's new rule for titles of twelve characters or fewer (counted only in emphasised form).
- The sub-obligation countdown `STD-SUBCOUNTDOWN-backreference-completion` (owner `ACT-1768`) moves from `2026-11-13` to `2026-11-27`, and its text narrows from "drive the baseline to zero and widen the population beyond registry-cited files" to "widen the population beyond registry-cited files". The line says the re-date is by the operator's approval of this change.

No article is added, removed, renamed or re-parented. No other family's text changes.

## Why

The countdown expired. From 2026-11-14 00:00 UTC `scripts/lint-documented-only-countdown.mjs` failed on every tree, `dev:preflight` failed with it, and every Local Verify run failed on `tests/e2e/dev-preflight-cli.test.ts` (PR 3079 at 00:02 UTC, PR 3137 at 00:06 UTC, the `main` verify at 00:14 UTC, then ten more queued PRs within eight minutes).

## Review

Round 1, author (echo:claude-code): derived each of the 27 back-references from the registry's enforcement fields by script (article heading above each `**Applied through.**` / `**Enforced by (structure, not willpower).**` / `**Enforcement.**` line, paths in backticks), and checked `lint-standard-code-backreference` (70 of 70, 0 grandfathered), `lint-documented-only-countdown` (clean, soonest remaining countdown 2026-12-21) and the whole `npm run lint` chain (exit 0).

Round 2, independent verifier (a separate reviewer session with no access to the author's reasoning, read-only): re-derived the mapping and confirmed all 27 headers name only articles whose enforcement field cites that exact path, with titles spelled as the headings, and that no citing article is missing; confirmed shebangs and `safe-git-allow` markers are intact; confirmed the lint change only widens acceptance and that no passing file relied on a short title; confirmed the new registry sentences ("all 70", "baseline is empty", the short-title sentence) are true of the diff; ran the hierarchy, placement, parentage, single-obligation and duplicate-definition lints clean.

### Findings and disposition

1. **The Building area audit was stale** (`docs/standards-registry-area-audits.json` still bound to the pre-change text). Resolved in the same change: this report, `docs/audits/standards-backreference-completion-building-family-2026-11-13.json`, and the ledger entry bound to the new area hash. The reference-resolution floor is unchanged (34 of 40).
2. **A back-reference header split a multi-line `safe-git-allow` comment** in `scripts/class-closure-lint.mjs` and `scripts/lint-no-unregistered-self-action.js`. Resolved: the header now follows the whole marker comment in both files.

Noted, not a defect of this change: the lint's short-title branch has no unit test of its own (the lint has none at all; `tests/unit/lint-chain-completeness.test.ts` checks only that it is in the chain). Tracked as CMT-1748.

No unresolved design question. The one decision in the change, the new date for the remaining half of the sub-obligation, is the operator's and is made by his approving review of the registry line.

## What this review does not establish

That each named standard is the *right* governing standard for its file: the article says accuracy is a reading, and that sentence stays. That infrastructure the registry has never cited carries a back-reference: that is the remaining half, dated 2026-11-27.

## Verdict

Building: accepted.
