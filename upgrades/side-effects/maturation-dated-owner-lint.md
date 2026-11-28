# Side-Effects Review — every dark ladder rung carries a dated owner (the build check)

**Version / slug:** `maturation-dated-owner-lint`
**Date:** `2026-11-27`
**Author:** `echo (Pipeline Strategy, owner of the 21 Dec countdown cliff by the Chief of Staff's assignment)`
**Second-pass reviewer:** `independent read-only reviewer subagent — CONCUR on re-review`

Not to be confused with `upgrades/side-effects/maturation-dated-owner.md`, the review record of the clause (h) constitution change (#2872). This file covers the code that enforces the dated-owner half.

## Summary of the change

- `src/monitoring/MaturationLadder.ts`: the parser accepts optional `tracking.owner` (text, 120 characters or fewer), `tracking.reviewDue` (a real calendar date, YYYY-MM-DD) and `tracking.reviewDueReason` (text, 240 characters or fewer). It refuses them only when present and malformed, because one invalid row rejects the whole registry at runtime.
- New `scripts/lint-maturation-dated-owner.mjs`, in the blocking lint chain: it FAILS a `ladder` entry that is not `finished` and lacks an owner or a real date. A passed date is reported by name, not failed.
- `src/data/feature-ladders.json`: all 231 dark rungs are seeded with owner, date and reason by a reviewed script, using the Chief of Staff's area-owner rulings (2026-11-27 17:23 and 17:26), with at most 15 rungs due per owner per ISO week. All 261 entries are otherwise byte-for-byte unchanged in content (verified by the second reader).
- Tests: `tests/unit/lint-maturation-dated-owner.test.ts`.
- Release note: `upgrades/next/maturation-dated-owner-lint.md` (patch bump; nothing to tell users beyond the ladder API's new fields). The existing `MaturationLadder.test.ts` and `feature-ladders-coverage.test.ts` are unchanged and pass.
- **Not in this change: the registry text.** Marking `STD-SUBCOUNTDOWN-maturation-bcd` met, and updating the article's "Today no entry carries a structured owner or review-due field", ship in the single registry PR for the 21 Dec cliff (the Chief of Staff's ruling, 2026-11-27 17:50). This PR's lint passes on main's registry as it stands.

## Decision-point inventory

One commit-time check. The runtime parser gains only optional fields.

## 1. Over-block

A new switched-off feature must carry an owner and a date from day one. That is the rule's intent. A passed date never blocks.

## 2. Under-block

- A named owner who is not working, a far-off date, or an owner name that is not a live session. The lint checks shape and calendar validity, not truth.
- One seeded owner, `echo-token-pacing` (5 rungs), is the Token Pacing project's session and is not live in the pool right now. A message to it would be reported as undelivered in the daily summary.
- **Owner naming:** the article says the owner is "the agent, by id". On a single-agent install every rung's agent is the same, so the seeded value is the owning project SESSION within the agent. That is the unit that actually brings a rung to review here. The registry PR states this reading.

## 3. Level-of-abstraction fit

The "must fail the build" half is a build-time lint, deliberately not in the runtime parser: one invalid row there rejects the whole registry, the blast radius that hid the maturation board on 27 November (#4019).

## 4. Signal vs authority compliance

It blocks on a declared structural fact, whether the field is present. Overdue is a signal.

**Who reads the signal.** The article says a rung "never expires silently". On this agent the reader is the Feature maturation owner's daily watch: Pipeline Strategy, `.instar/scripts/standards-countdown-watch.py`, 08:00, agent-local. It reads main's ladder file and messages each owner's session with its overdue rungs, and it sends the Chief of Staff a summary that names any owner it could not reach. Tested against the seeded data with the date set to 2026-12-08, it lists 130 rungs, which matches the second reader's count. A fleet agent that runs no development ladder gets only the lint's report. That is a stated limit, not a hidden one.

## 4b. Judgment-point check

None: whether a field is present is not a judgment.

## 5. Interactions

`tests/unit/feature-ladders-coverage.test.ts` already requires an entry for every switched-off flag, and that entry now also needs an owner and a date. The maturation board and `/maturation/ladder` pass the new fields through, so the API now returns owner and review date for each rung. Clause (d), routing, is satisfied in structure: the owner and date live on the ladder entry, which the article names as the home. The lint does not check that decisions made elsewhere were routed there.

## 6. External surfaces

At runtime, `/maturation/ladder` and the board data now include owner, review date and reason. No route or config changes.

## 7. Multi-machine posture

The lint is machine-local by design. The daily reader runs on the Studio and reaches owners on other machines through the pool's session list.

## 8. Rollback cost

Revert the PR. The fields are optional, so older code reads the seeded file unchanged.

## Second-pass review

**Reviewer:** independent read-only reviewer subagent, launched by the Pipeline Strategy session with no part in writing the change. It worked from the working tree and its own temporary copies.
**Verdict:** DISSENT, then CONCUR on re-review (2026-11-27 18:57).
- The DISSENT named three blocking problems: an existing review record had been overwritten, the overdue report had no reader, and the countdown was claimed closed with the registry unchanged. It also named smaller points: owner naming, impossible dates, and doc inconsistencies.
- All were fixed. The reader re-checked the data (261 entries unchanged apart from the three fields, 231 seeded) and passed 64 of 64 tests.
- Remaining notes, stated here rather than hidden: the overdue reader is agent-local, so the repository neither versions nor tests it; and a failed summary send can repeat an owner's message on re-run.
Review record: `.instar/state/handoffs/reviews/maturation-dated-owner-review.md` (agent-local).

## Release note fix (2026-11-27, about 20:35 PT)

CI assembles the release notes from main plus this branch. Main's upgrades/next/ was empty after a release, so this fragment was checked alone, and it failed the repository invariant "missing ## Summary of New Capabilities section" (seen on #4038). Fix: a "Summary of New Capabilities" section added. This change touches src/ (the ladder parser), so it cannot use the internal-only marker. Checked alone with the repository's own assembleNextMd and validateGuideContent: the old version fails and the new one passes.

## Review binding (2026-11-28)

The independent reader's concurrences (second-pass/maturation-dated-owner-review.md, two rounds; echo-pipeline-strategy-release-note-fix-1127.md, including its 4044 package.json read of 2026-11-28 00:18) cover this change. This section and a fresh trace were written after the final merge of main 49dc53022a into 881bbafc62, so the trace covers every path the PR changes as it now stands.
