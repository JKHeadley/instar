# W25 LANE 5 — BLOCKER B-1 DOES NOT COMPOSE. REPAIR IT.

## What is established — measured, not inferred. Build on it, do not re-derive it.

B-1 (stop must not delete the live state record) was built by an earlier lane and is correct in
intent. Its branch is at `refs/w25-backup/b1-stop-preserves-state` (`4ba27703c`) in the live repo
and on origin. Its own must-fail control is sound: reverting `src/core/AutonomousSessions.ts`
makes `stopAutonomousTopic preserves the topic record` fail with `expected false to be true`.

**But merged into the release candidate it breaks five tests across four files.** The orchestrator
ran the FULL suite twice on the same machine in the same environment and isolated it:

WITH B-1 merged (candidate `70e896ab4` + lane-4 fix + B-1):
    Test Files  5 failed | 3159 passed | 4 skipped (3168)
    Tests       6 failed | 49845 passed | 30 skipped | 3 todo (49884)      EXIT=1

WITHOUT B-1 (candidate `70e896ab4` + lane-4 fix, identical otherwise):
    the same five files: 4 passed, 1 failed — and that one was a stale GENERATED artifact,
    since regenerated with `node scripts/generate-builtin-manifest.cjs`, now passing 10/10.

So B-1 introduces exactly these, and nothing else in the suite:

1. `tests/unit/telegram-stop-journal-seam.test.ts` — TWO tests
   "threads the injected seam into stopAutonomousTopic on a sentinel emergency-stop"
   "does not throw when no seam is injected (seam is optional)"
   both: `AssertionError: expected true to be false`
   THIS IS THE IMPORTANT ONE. It is a test about the exact surface B-1 changed — the
   emergency-stop path into `stopAutonomousTopic` and its coherence-journal seam.
2. `tests/unit/no-silent-fallbacks.test.ts` — 498 vs a ceiling of 496. B-1 adds TWO silent
   fallbacks. Without B-1 the same tree measures exactly 496.
3. `tests/integration/feedback-drain-performance.test.ts` — expected
   `feedback-work:newer-eligible:1` to be `feedback-work:oldest-eligible:1`
4. `tests/integration/threadline-pairing-routes.test.ts` — expected 401 to be 200

## THE FIRST QUESTION, AND ANSWER IT BEFORE YOU FIX ANYTHING

Is B-1 BROKEN, or does it merely CONFLICT with the candidate? These need different fixes and the
distinction is cheap to measure.

B-1 was built on `main` at `dbaacd25b` and its worker ran only TARGETED tests — it never ran the
full suite. So it is entirely possible these four files were already failing on its own base and
nobody looked. Check that FIRST: check out B-1's branch alone, on its own base, and run those four
files. Then you know whether you are repairing a defect B-1 always had, or an interaction with the
candidate. Say which, with the measurement.

## What the fix must and must not do

- The behaviour B-1 delivers is REQUIRED and must survive your repair: an emergency stop halts the
  run and PRESERVES the live state record. Do not fix the failures by weakening that. If your
  repair makes `stopAutonomousTopic preserves the topic record` pass only because the stop no
  longer stops, you have destroyed the blocker to save the tests.
- Do NOT raise the silent-fallback ceiling to 498. The two fallbacks B-1 adds must REPORT before
  they fall back, the way lane 4 fixed the previous two. Read that lane's patch for the pattern:
  `.instar/w25/preserved/lane-4/lane-4-fix.patch`.
- Do NOT edit, skip, or loosen the seam tests to make them pass. If after real investigation you
  believe a seam test encodes a stale expectation, STOP AND REPORT with the argument. That is a
  decision above your authority.
- Do NOT modify the excluded `lane-b1-repo` ref and do not merge it — different thing, same-ish
  name. B-1 the BLOCKER is `refs/w25-backup/b1-stop-preserves-state`.

## Where to work

Clone locally into a scratch path under the window directory, NOT `/private/tmp` — two lanes today
left their only copy of finished work in temporary storage uncommitted, and it had to be rescued
both times. Use:
    /Users/dabombstudio/.instar/agents/echo/.instar/w25/repos/b1-repair
Symlink `node_modules` to the live tree's rather than installing.

COMMIT YOUR WORK AS YOU GO, on your branch, in that clone. Do not leave it as unstaged changes.
If the pre-commit gate refuses a source commit for a missing side-effects review, STOP AND REPORT
that — do NOT use `--no-verify`, and do not work around it. That gate is deliberate and the
orchestrator has already declined to bypass it once today.

## The bar

For each of the five failing tests: the measurement showing it failing with B-1, your diagnosis of
why, your fix, and the must-fail control proving your fix is what makes it pass. Then the four
affected files green together, and `node_modules/.bin/tsc --noEmit` at exit 0.

Do NOT run the full suite — it takes over half an hour and the orchestrator will run the
authoritative one. Report the targeted results and stop there.

Read `EXIT=` and the `Test Files` summary line for every run you report. A wrapper's exit status is
not the runner's: that mistake was made on this window twice today, once by a worker and once by
the orchestrator.

## Report to

`/Users/dabombstudio/.instar/agents/echo/.instar/w25/lane-5-b1-repair.md` — write as you go.
