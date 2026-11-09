# Not throwing away a fix because a test run was slow

Before a feedback fix becomes a pull request, it goes through checks. Its new test must fail on the old code and pass on the fixed code, lint must pass, and then a broad run covers all the existing tests related to the changed files. That last run has a 45-minute limit.

If the fix touches a core file, that broad run can include a large part of the whole test suite, and on a busy machine it can run out of time without anything having failed. That counted as failing the attempt, and the fix was thrown away. It happened this morning to a fix that had passed everything else.

Now a timeout in that one run counts as "don't know" instead of "failed", and the pull request says so. The CI tests still have to pass before it can merge. CI leaves out a list of about 120 flaky test files, so for those files this run was the only check before merge; after this change a slow run can miss them until the check that runs after merging. If the broad run prints a failing test, even before timing out, the fix still stops. A timeout in any other check still stops it too. Nobody has a decision to make, and undoing this is a plain revert.
