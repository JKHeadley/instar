# Stacked pull requests and CI time limits — plain-English overview

**What went wrong, part one.** Sometimes work is split into a "stack": pull request B is built on top of pull request A, so B's target is A's branch instead of main. Our automated test suite on GitHub only runs for pull requests aimed at main. So B never ran a single test on GitHub, yet GitHub still called it "clean" and ready to merge. One pull request (#2202) was actually merged branch-to-branch this way on 2026-10-19, and on 2026-10-08 another stacked PR (#2142) failed two tests the first time it was finally pointed at main.

**What changes, part one.** A pull request aimed at anything other than main can no longer be merged by our tools, and GitHub no longer shows it as clean:

- Our merge script refuses it with "refused: non-main base" and says exactly what to do: merge the PR underneath into main first, then point this PR at main (`gh pr edit <PR#> --base main`) so the tests run, then retry. It refuses before doing anything else, in every mode.
- A new tiny GitHub check runs only on stacked PRs and always shows red with that same instruction, so a human looking at GitHub also sees "not ready".
- The background merge watcher skips stacked PRs instead of trying and failing, and its "this PR has been red for hours" alarm ignores them, because they are red on purpose.

**Why this option and not the others.** We could have run the full test suite on every stacked PR too. That would roughly double CI work on stacks, and our GitHub Actions allowance is already so crowded that a single PR can wait hours. Making GitHub itself require checks on every branch is a repository setting, not something a reviewed code change can carry. Stacks still work the same way for review; they just land through main, where they get tested exactly once.

**What went wrong, part two.** No CI job had a time limit, so a stuck job ran for GitHub's default six hours. On 2026-10-08 one hung test shard held a pull request blocked for six hours while everything else was green.

**What changes, part two.** Every CI job now has a time limit, set to about twice its slowest real run over the last 79 runs: unit test shards 60 minutes (slowest was 30), integration 50 (slowest 24), end-to-end 70 (slowest 35), and the small checks 15 (slowest under 4). A stuck job now fails within about an hour and can be re-run.

**Safeguards.** Everything here can only say "do not merge yet" or "stop a stuck job sooner". Nothing can make a merge happen that would not have happened before. Undoing it is reverting one commit.

**What you need to decide.** Nothing.
