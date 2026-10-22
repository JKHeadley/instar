# Zero checks is not "green" — plain-English overview

**What went wrong.** A pull request can show up on GitHub with no automated test runs at all. That happened to PR #2302 during the 24-hour run on the Mama PC. The branch conflicted with main, so GitHub never started the test workflows, and it still did not start them after the conflict was fixed. The only thing that reported was Vercel, the preview-deploy service. At a glance, "no checks ran" and "all checks passed" look alike: nothing is red.

**Why that is dangerous.** Two parts of the merge machinery made exactly that mistake. The background watcher that merges our own green pull requests decided "green" by asking whether anything had failed or was still running. With zero checks, nothing had, so it counted the PR as green. The merge script's "auto" mode then asks GitHub to merge when the required checks pass. This repository has no required checks, so GitHub would merge immediately, with no tests run at all.

**What changes.** Both places now apply one plain rule: if no GitHub Actions check ran on this exact commit, it is not green. The watcher marks such a PR "no checks ran" and waits, writing that reason to its log so it can be seen. The merge script refuses with "refused: no checks ran" and prints a line saying the PR is NOT green, that the test workflows never started, and that someone should rebase or start the workflow by hand and try again. The slower, careful merge mode already refused in this case; it now gives the same clear reason instead of a vaguer one about a missing end-to-end test.

**What does not change.** The local-verify path, where this machine runs the full test suite itself and records the result, never relied on GitHub's checks, so it works exactly as before. Projects that users build with Instar, some of which have no CI at all, are not affected; that separate check is left alone on purpose.

**Safeguards.** The new rule can only ever say "do not merge yet". It never makes something merge that would not have merged before. If it is wrong, reverting the one commit restores the old behaviour, with no data to repair.

**What you need to decide.** Nothing. This only makes the merge path more careful in one specific case that was found in a real run.
