# Side-Effects Review — the back-reference lint covers decision infrastructure, not only registry-cited files

**Version / slug:** `backreference-infrastructure-population`
**Date:** `2026-11-27`
**Author:** `echo (Pipeline Strategy, owner by the Chief of Staff's assignment, 2026-11-27 16:28; CMT-2373)`
**Second-pass reviewer:** `independent read-only reviewer (Pipeline Strategy's review subagent): CONCUR on bee6368e, CONCUR on the bee6368e..736b184e delta`

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

## Second-pass review

**Reviewer:** independent read-only reviewer subagent, launched by the Pipeline Strategy session with no part in writing the change. It worked from the diff and a temporary worktree only.
**Verdict:** CONCUR, on both heads.
- **bee6368e** (the lint, the baseline, the registry edit and the tests): CONCUR, with one follow-up that should land soon. Evidence: both lints pass, the hierarchy check and the other registry lints are clean, and the test file passes 16 of 16. The shrink-only baseline holds: a file that gains a back-reference must leave it, the write flag refuses once a baseline exists, and a missing or corrupt baseline fails all 268 files, so it fails safe. The follow-ups (a ceiling equal to the baseline size, corrupt and stale baseline failures, whole-word name matching) are built on a separate branch, to land after this merges.
- **bee6368e..736b184e** (the Building family audit record): CONCUR. The change is docs, audit data and a trace only. The floor is unchanged at 34/40. `auditSha256` and `convergenceSha256` match the committed files, and `areaSha256` matches the live area (`standards-coverage.mjs --check` was run on that head).
**Why this section was added in a later commit:** the trace written with bee6368e recorded the second pass before the reviewer had concurred, and the 736b184e trace did not cover the registry. So the shared verifier's protected-path rule ("an independent second-pass review in the head's tree, covering every flagged path") could not be met. This commit records the concurrence in machine-readable form, with a trace covering every file the PR changes. The reviewed content is unchanged.

**Follow-up PR (this change), reviewed by a second independent read-only reviewer subagent, separate from the 4024 reader:** DISSENT twice, then CONCUR.
- Round 1 DISSENT: a count-only ceiling could be beaten by swapping an entry, and SendGateway, a real gate, had been dropped. Both fixed.
- Round 2 DISSENT: a shrink-and-add could beat the hash. Fixed by checking entries against main's copy.
- Round 3 CONCUR, plus the rebuild check on this fresh branch from main 1d2c1ea8: the five carried files are byte-identical to the reviewed tree, the check against main is active and passes (267 is a subset of 268), and there is no contradiction with main's line 947.
- The two tests that reader suggested (a NOTE when main has no baseline; a named failure when main's copy is unreadable) are added. 25 of 25 pass.
Review record: `.instar/state/handoffs/reviews/pr-backreference-followups-c0b18224-review.md` (agent-local).

## Follow-up after the independent review of PR 4024 (2026-11-27 16:39)

The reader concurred and named three gaps, all fixed in a follow-up PR built fresh from main after #4024 merged:

1. **Shrink-only in both directions, and pinned by content.** `INFRA_BASELINE_CEILING` (267) and `INFRA_BASELINE_SHA256` (sha256 of the sorted entries) live in the lint's own source. The size must EQUAL the ceiling: above it means a hand-added entry; below it means both lines must be updated so the freed places cannot be refilled. The hash catches a swap: fixing one baselined file and putting a new unreferenced guard in its place keeps the count but changes the hash. The second reader reproduced that attack against the count-only version, and it now fails. The reader then beat the hash with a shrink-and-add that updated both lines, which reads like an honest shrink in review. So the decisive check is against git: every entry must already be in main's copy of the baseline (merge-base with origin/main, JKHeadley/main or main). The CI lint job has full history (fetch-depth 0). Where no main is reachable, the lint prints a NOTE and the ceiling and hash remain. A delete-and-rewrite fails the same way. Duplicate entries fail. A stale entry (a file deleted, renamed, or no longer named like a guard) fails by name.
2. **Corrupt baseline.** Present but unreadable or malformed now fails by name. Absent still counts as empty, the strictest state.
3. **Whole-word names.** Guard words match only as whole words of the file name (CamelCase or -/_/. separated), including the forms guarded, guardian, gated, gating and fenced. It drops one false hit, DesktopDelegatedSessionStore (inside "Delegated"). `gateway`/`gateways` are guard words: the second reader showed SendGateway is a real gate ("Central review point for all outbound messages", fail-closed), so it and A2AGateway stay in the population. Plurals and the closed compounds Safeguard, Gatekeeper and Guardrail are listed explicitly, because a whole-word rule would otherwise miss names the substring rule caught. Regatta and Fenceless do not match. The population is 288, with 267 baselined.

Tests now cover all of these: 25 of 25, with 9 new cases (a hand-added entry over the ceiling and the ceiling left too high; a swapped entry against the pinned hash; a shrink-and-add against main's copy in a real git fixture; duplicate, non-text and null entries; a corrupt and a malformed baseline; a stale entry; whole-word matching both ways, including gateways, plurals, compounds, Regatta and Fenceless). Tests that need a baseline run a copy of the lint with its ceiling and hash set to the fixture's list. There is no environment override, because one would switch the ceiling off.

**Stated limits after three review rounds (the reader's final verdict: CONCUR).**
- (i) When the branch forked before main held the baseline, there is nothing on main to compare with. The lint then prints a NOTE, and CI's merge ref conflicts on the file until the branch is rebased.
- (ii) Moving the baseline file to a new path skips the check against main, but only by editing the path string in the lint itself. That is a visible change to the guard, in the same class as deleting it.
- (iii) Where no main is reachable (no history), the lint prints a NOTE and only the ceiling and hash apply. CI's lint job has full history.

## Release note placement (2026-11-27, about 21:15 PT)

This follow-up first edited upgrades/next/backreference-infrastructure-population.md, the fragment from #4024. Release v1.3.2111 has since shipped that fragment as upgrades/1.3.2111.md, so merged with main, the edit would rewrite the shipped notes. The original fragment is restored unchanged, and this follow-up's note is its own fragment, upgrades/next/backreference-followups.md. That fragment is marked internal-only, because the change is a lint and its tests, and nothing under src/ changes.
