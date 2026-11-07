# A test stops depending on one fixed folder name

**What this is.** One test in the suite that guards merges creates a temp folder named after a fixed fake attempt id. If that folder already exists, the test fails.

**Why it matters.** A run at about 2:06 PM on November 6 left that folder behind, empty and owned by the separate user that runs tests, so ordinary runs could not reuse or remove it. From then on the test failed on the Mac Studio every time. The merge queue read that as main being broken and held every PR that was not fixing it, eleven at the last count.

**What changed.** The test now makes up a new random id each run, so it never meets an old folder. The change is one line plus an import. It is the same line already written in PR 2885, split out because that PR also carries other work and now has merge conflicts.

**What did not change.** Nothing that runs on an agent. Real attempts already use their own ids. The leftover folder is still there and is now harmless.

**If it is wrong.** Revert it. Nothing is stored or migrated. PR 2885 will show no change for this line once it is rebased.
