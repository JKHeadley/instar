# Local-Verify Merge Authority — the plain-English version

## What is wrong today

Before a change to Instar is merged, its tests have to pass. Right now the tool that does the merging only believes GitHub. It waits for GitHub's own test jobs to come back green. GitHub often makes those jobs wait in a queue for hours, and sometimes refuses to run them at all because the monthly allowance is used up.

Justin has asked many times for sessions to run the tests on our own machines instead. That never stuck, because the instruction was only words: the merge tool itself still waited on GitHub, whatever a session was told.

There was a second problem. Running all the tests locally took over an hour, because every test file ran one after another.

## What we measured

Over the last 80 merged changes, half took under 2.7 hours from opening to merging, and one in ten took more than 33 hours.

On the Mac Studio, unit tests run 8 at a time finished in under 4 minutes, every one passing. Integration and end-to-end tests have two known clashes (shared network ports, shared terminal sessions) that make them unsafe to run in parallel yet, so they stay one at a time for now: 15 and 24 minutes. A full check is therefore about 45 minutes, against over an hour today, and with no GitHub queue or billing limit in the way.

**Update, 2026-10-22.** With the new system live, PRs queued for hours again, because each check took about 45 minutes and only one could run at a time. The check now runs its three groups of tests at the same time, and splits the slowest group in two. Each part gets its own private terminal sessions, so they can't interfere with each other. The machine still runs only one full check at a time. Measured on the Studio: about 20 minutes instead of 42, with every test passing except one timing test that assumed a busy machine; that test is fixed separately.

## What changes

1. **Unit tests run in parallel**, and nothing runs twice any more.
2. **Our own server runs the check.** For each pull request that is ready to merge, the Instar server runs the whole test suite on exactly the code that would land, and keeps the result. A session cannot hand in a result of its own.
3. **The server posts a pass/fail mark on the pull request**, using GitHub's free status feature (no Actions minutes, no queue). The mark only says "pass" when the tests passed on that exact code. A riskier change (to the test setup or the merge tool itself, or one that skips or deletes tests) also needs a second, independent review of that exact code, written down in the change itself. Justin does not approve these: on 2026-10-22 he said he should only have to approve changes to the constitution, and GitHub already holds those for his review.
4. **GitHub requires that mark before any merge.** This is one branch-rule setting that Justin turns on. After that, any merge without a pass is refused by GitHub itself, whichever session, tool or machine tries it.
5. **After every merge, `main` itself is re-tested.** If it breaks, merges pause except for the fix, and Justin hears about it once.

For pull requests that do not come from our own agents (forks, outside contributors), the server simply copies GitHub's own test result onto the same mark, so nothing changes for them.

### The merge line (added 2026-10-23)

Before this change the queue of waiting PRs got reshuffled every time `main` moved: a PR that had been waiting for hours was quietly moved to the back of the line (that is what happened to PR 2320, which waited eighteen hours), and a PR whose tests had passed still sat there until the merge watcher's next ten-minute look. Now the queue behaves like a proper line. A waiting PR keeps its place when `main` moves or when it gets a new commit. Each PR is tested against `main` as it is at that moment, not as it was when the PR joined the line. And the moment a PR's tests pass, it is handed straight to the merge watcher, and the line pauses (for at most half an hour) until that merge has landed or been refused, so the next PR is tested on top of it. Nothing about what is allowed to merge changes: the same checks apply — only Justin approves constitution changes, a change to the test harness still needs its independent second review, and GitHub still refuses a merge without the green status. If the hand-off ever misbehaves, one setting (`monitoring.localVerify.mergeLine: false`) puts merges back on the watcher's ten-minute rhythm without a restart.

## Why this is safe enough

The pass mark is tied to one exact version of the code, so an old result, or a result for different code, does not count. If the server cannot check something, the answer is "don't merge yet", never "merge anyway".

Honest limits: the tests report their own result (exactly as on GitHub today), and the mark is posted with the same GitHub login the agents use, so a session that deliberately set out to fake it could. That is deliberate tampering, which this design does not try to stop; it stops the accidental case, which is the one that actually happens.

## Flaky tests and taking turns

A few tests fail now and then for no real reason, especially when the whole suite runs at once. When a run fails only one to three files, the checker re-runs just those files on their own. If they pass, the run counts as passing, and each such test is logged as something to fix. It does not do this when the PR touched that test or the code it uses, because then the failure may be real. Checks of the main branch and checks of pull requests also take turns now, so the main branch can't keep the checker busy while PRs wait.

## How it rolls out

First the faster tests. Then the server starts posting the mark on every open pull request, while GitHub's checks keep working as today. After 10 real checks, Echo sends Justin the measured numbers, and on his yes switches merges over and sends him the one-tap link for the branch-rule setting. One setting puts everything back the way it is today.

## What it means for Justin

Merges stop waiting on GitHub, and nobody has to remember to "just run the tests locally": the merge itself requires it.

## Update restart gap repair

An update can finish installing before the server has restarted into it. During that short gap, an idle helper machine previously accepted a new PR check and then lost it when the restart arrived. From installation until the restart decision, the old server now keeps new checks paused. A deferred restart releases that brief pause, and the existing hold rules govern later retries. When a retry actually decides whether to restart, the brief pause returns so a new check cannot slip into the gap. Checks already running still get the existing restart hold. A failed install releases the pause, and a newly started server begins with it clear. This also covers an update Justin asks to apply manually while automatic updates are off.

The M5 exposed a separate test fixture assumption: tmux 3.7c sometimes leaves a dead pane's pid field empty, while older tmux keeps the old number. The process-ownership test now accepts either observation and still verifies that cleanup sends no process signal. That stops unrelated PRs from going red because of the helper machine's tmux version.
