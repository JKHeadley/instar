# Local-Verify Merge Authority — the plain-English version

## What is wrong today

Before a change to Instar is merged, its tests have to pass. Right now the tool that does the merging only believes GitHub. It waits for GitHub's own test jobs to come back green. GitHub often makes those jobs wait in a queue for hours, and sometimes refuses to run them at all because the monthly allowance is used up.

Justin has asked many times for sessions to run the tests on our own machines instead. That never stuck, because the instruction was only words: the merge tool itself still waited on GitHub, whatever a session was told.

There was a second problem. Running all the tests locally took over an hour, because every test file ran one after another.

## What we measured

Over the last 80 merged changes, half took under 2.7 hours from opening to merging, and one in ten took more than 33 hours.

On the Mac Studio, unit tests run 8 at a time finished in under 4 minutes, every one passing. Integration and end-to-end tests have two known clashes (shared network ports, shared terminal sessions) that make them unsafe to run in parallel yet, so they stay one at a time for now: 15 and 24 minutes. A full check is therefore about 45 minutes, against over an hour today, and with no GitHub queue or billing limit in the way.

## What changes

1. **Unit tests run in parallel**, and nothing runs twice any more.
2. **Our own server runs the check.** For each pull request that is ready to merge, the Instar server runs the whole test suite on exactly the code that would land, and keeps the result. A session cannot hand in a result of its own.
3. **The server posts a pass/fail mark on the pull request**, using GitHub's free status feature (no Actions minutes, no queue). The mark only says "pass" when the tests passed on that exact code, and any change that needs Justin's eye (to the test setup itself, or a PR that skips or deletes tests) has his approval.
4. **GitHub requires that mark before any merge.** This is one branch-rule setting that Justin turns on. After that, any merge without a pass is refused by GitHub itself, whichever session, tool or machine tries it.
5. **After every merge, `main` itself is re-tested.** If it breaks, merges pause except for the fix, and Justin hears about it once.

For pull requests that do not come from our own agents (forks, outside contributors), the server simply copies GitHub's own test result onto the same mark, so nothing changes for them.

## Why this is safe enough

The pass mark is tied to one exact version of the code, so an old result, or a result for different code, does not count. If the server cannot check something, the answer is "don't merge yet", never "merge anyway".

Honest limits: the tests report their own result (exactly as on GitHub today), and the mark is posted with the same GitHub login the agents use, so a session that deliberately set out to fake it could. That is deliberate tampering, which this design does not try to stop; it stops the accidental case, which is the one that actually happens.

## How it rolls out

First the faster tests. Then the server starts posting the mark on every open pull request, while GitHub's checks keep working as today. After 10 real checks, Echo sends Justin the measured numbers, and on his yes switches merges over and sends him the one-tap link for the branch-rule setting. One setting puts everything back the way it is today.

## What it means for Justin

Merges stop waiting on GitHub, and nobody has to remember to "just run the tests locally": the merge itself requires it.
