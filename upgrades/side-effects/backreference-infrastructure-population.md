# Side-Effects Review — the back-reference lint covers decision infrastructure, not only registry-cited files

**Version / slug:** `backreference-infrastructure-population`
**Date:** `2026-11-27`
**Author:** `echo (Pipeline Strategy, owner by the Chief of Staff's assignment, 2026-11-27 16:28; CMT-2373)`
**Second-pass reviewer:** `required (the lint can fail commits); to be named`

## Summary of the change

`scripts/lint-standard-code-backreference.mjs` checked only the 70 files the standards registry cites as enforcement. It now also checks every shipped file under `src/` or `scripts/` whose name marks it as decision infrastructure: Guard, Gate, Sentinel, Watchdog, Ratchet, Breaker, Reaper, Limiter, Governor, Authority, Verifier, Arbiter, Fence or Detector, plus `scripts/lint-*` and hook sources. Templates, `.d.ts` files and `__tests__` folders are excluded, and so are files already cited. Each such file must name a real registry article in its first 4,000 characters, using the same matching rule as the cited set.

The 268 files that do not yet name one are in a new shrink-only baseline, `docs/standards-backreference-infrastructure-baseline.json`, written once by `--write-infrastructure-baseline`. The flag refuses to rewrite an existing baseline. An absent baseline counts as empty.

The registry article *References Run From Both Ends* is updated: it records the widening, states the name rule's limit as the remaining unenforced sub-obligation, and moves `STD-SUBCOUNTDOWN-backreference-completion` to the narrower residual with a new date (2027-02-26, the operator's to set), owned by Pipeline Strategy.

## Decision-point inventory

- **lint-standard-code-backreference** (commit-time lint chain and CI) — modify. It now fails a commit that adds a new decision-infrastructure file with no back-reference, or that leaves a now-compliant file in the baseline.

## 1. Over-block

- **A new file named like a guard** (for example `FooGate.ts`) that is not really a guard must still name a standard. The cost is one header line, and a gate is almost always governed by some article.
- **Open PRs.** On 27 November, 15 open PRs added 18 new guard-named `src` files. Each will need that one line at its next push, and the error message says exactly what to write.

No legitimate file is refused for something it cannot fix.

## 2. Under-block

- A file that guards or decides without being named like one is still outside the check. The registry states this as the remaining sub-obligation, with a countdown.
- The check confirms that a file names *a* standard, not the right one.

## 3. Level-of-abstraction fit

This extends the existing lint, using the same matching and the same shrink-only baseline pattern. It adds no new tool. A code-sourced population, such as the guard manifest, would be better, but the manifest records configuration switches, not files, so it cannot provide a file list today. That is the residual countdown.

## 4. Signal vs authority compliance

- [x] It holds blocking authority (a lint) with a deterministic, exact rule: a file name match plus a header substring match against real article titles.
- It is not a judgment. The failure is always fixable by the author in one line, and the baseline means no existing work is blocked.

## 4b. Judgment-point check

There are no competing signals.

## 5. Interactions

- **`lint-documented-only-countdown.mjs`:** the article keeps one dated sub-obligation, the residual, so that lint stays clean. Its next countdown is now 2026-12-21.
- **`generate-standards-hierarchy --check`:** it reads the registry; the generated asset is refreshed in the same commit if the build step requires it.
- **Cited set:** unchanged.

## 6. External surfaces

Developers and agents committing to the repository see one new possible lint error, and its text tells them the fix. There is no runtime change, and nothing ships to agents' behaviour.

## 6b. Operator-surface quality

Not applicable: there is no operator UI.

## 7. Multi-machine posture

This is a repository check, so it is machine-independent by nature.

## 8. Rollback cost

Revert the commit. The baseline file goes with it, and the registry text returns to its prior wording.

## Evidence pointers

- `tests/unit/lint-standard-code-backreference.test.ts`: 6 new cases, all passing, 16 of 16 in the file through the shared wrapper on 2026-11-27. The cases are:
  - a new guard file with no header fails;
  - lint and hook files are in scope and pass once they name an article;
  - a baselined file passes, and must leave the baseline once it names one;
  - ordinary, template and `.d.ts` files are ignored;
  - an absent baseline counts as empty;
  - the baseline is written once and a rewrite is refused.
- On the real tree at main 096f6e88, with the registry edit, the lint reports: "70 cited file(s), 70 naming a standard back, 0 grandfathered; 289 further infrastructure file(s), 21 naming a standard back, 268 grandfathered", and the countdown lint is clean.

## Follow-up after the independent review of PR 4024 (2026-11-27 16:39)

The reader concurred and named three gaps, all fixed in a follow-up commit on the same branch line:

1. **Shrink-only in both directions.** `INFRA_BASELINE_CEILING` (265) lives in the lint's own source. The baseline's size must EQUAL it: above it means a hand-added entry; below it means the ceiling must come down so the freed places cannot be refilled. A delete-and-rewrite of the baseline now fails on the ceiling. A stale entry (a file deleted, renamed, or no longer named like a guard) fails by name.
2. **Corrupt baseline.** Present but unreadable or malformed now fails by name. Absent still counts as empty, the strictest state.
3. **Whole-word names.** Guard words match only as whole words of the file name (CamelCase or -/_/. separated), including the forms guarded, guardian, gated, gating and fenced. This drops three false hits: DesktopDelegatedSessionStore (inside "Delegated"), SendGateway and A2AGateway (network gateways). It keeps FencedLease, FencedOutbox, devGatedFeatures, leaseGatedSpawn and MentorAutonomousGuardian. The population is 286, with 265 baselined.

Tests now cover all of these: 20 of 20, with 4 new cases (a hand-added entry over the ceiling and the ceiling left too high; a corrupt and a malformed baseline; a stale entry; whole-word matching both ways). Tests that need a baseline run a copy of the lint with its ceiling set to the fixture's size. There is no environment override, because one would switch the ceiling off.
