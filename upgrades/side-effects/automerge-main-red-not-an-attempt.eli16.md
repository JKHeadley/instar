# A main-red refusal no longer uses up a PR's merge attempts (plain overview)

The auto-merger is the part of Instar that merges a pull request once its tests have passed on the Studio. It tries up to three times. If all three tries fail, it gives up on that PR and waits for someone to push new code to it.

One of the reasons a try can fail is that `main` itself is currently red: some test is failing on the main branch, so nothing should merge on top of it until it is fixed. That has nothing to do with the PR. But the auto-merger counted it as one of the PR's three tries. A short red spell on main could use up all three, and then the PR sat finished and unmerged until a person noticed. PR #2879 waited about two days like this.

Now, when the refusal is "main is red", the auto-merger notes it and tries again after a short wait, without counting it against the PR. The rule that stops merges onto a red main is unchanged, so nothing merges any sooner than it safely can. A PR with a real problem of its own still uses up its tries as before.

An independent review caught one more thing. Once a "main is red" refusal stopped counting as a try, the oldest refused PR would have ended every round of the auto-merger, so no newer PR got its turn while main stayed red. That included the PR fixing main, which is allowed to merge during a red spell. Now a "main is red" refusal hands the turn to the next PR in the same round, the same way the auto-merger already treats a PR still waiting for its checks.
