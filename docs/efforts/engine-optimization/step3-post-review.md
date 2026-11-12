# Step 3 post-review: building job-launch-intent-record

Written 2026-11-11 by Echo. This covers the build itself: the frozen-test round is covered in step2-post-review.md.

## What happened

- The build agent wrote the implementation against the 13 frozen test files. I then checked independently: all 13 pass, and none were changed (`git diff ee299d467` is empty on all 13).
- The full unit lane passed (65,630 tests) except for 6 files:
  - 3 desktop-capture files fail the same way on a different, unrelated worktree (SourceTreeGuard refuses the helper path inside a git worktree). They are not caused by this change.
  - 3 lint files failed under load and pass in isolation.
- Second-pass review: Fable 5.2 and GPT 6 Astra each read the diff on their own. Both returned CONCERN with no blockers.
  - Five findings were fixed, with a new test for each.
  - Three were declined, each with a reason: the null semantics, the migrator gate (a frozen test requires the current behaviour) and the ratchet offset (the frozen T8 already catches it).
  - Round 2 went to Astra to confirm the fixes.

## What went well

- **Frozen tests did their job.** The build could not quietly redefine "done". The five reads of the tests beforehand meant the review found gaps *beside* the tests, not holes *in* them.
- **The two reviewers overlapped on the most important finding.** Both found that built-in manifests would lose the setting on update. Each also found one thing the other missed: Astra found the legacy script rows, and Fable found the confined env path. Two models really are better than one here.
- **Declines were checked against the frozen tests before they were made.** The migrator-gate nit would have broken a frozen test, so it is declined rather than "fixed" into a red suite.

## What went badly

1. **The build agent ended without a result.** Its final message was "the lanes are still running": it backgrounded the suite and then ended its turn instead of waiting, so no report came back. The suite itself logged correctly to files. Cost: about 20 minutes of re-checking by hand.
   *Action:* build-agent briefs now say to write suite output straight to log files and report only after every lane exits. Logged in MEMORY.md.
2. **Reviewer tmux sessions died silently on the first launch** because of relative paths. Cost: one relaunch.
   *Action:* reviewers are launched with absolute script and brief paths and `tmux new-session -c <dir>`; logged in MEMORY.md.
3. **The Studio spawn retry loop ran with an empty auth token**, and its success test accepted any non-"cap" reply as success. Cost: one false "SPAWNED".
   *Action:* the loop now reads the token from a private file and treats any `"error"` reply as a failure.
4. **The PR helper is blocked by the Studio's rerouted-session cap (5/5)**, which other work holds. It is not a defect in this effort, but it is the critical path for both PRs.
   *Action:* a background retry runs every 4 minutes. If the cap is still full when the job-effort PR is ready, both PRs go in one helper session.

## Proportion

Tier 2. Build: one implementation, one review round with two models, one confirm round. The fixes were small and local; no design change was needed, so the round-2 tripwire did not apply.
