# Keeping the worktree monitor's report small

## What is going on

Every five minutes the agent checks its git worktrees: the extra copies of the code it works in. For each worktree whose branch has work not yet in the main line, it writes down the list of changed files. It saves the whole report to one file.

Some old branches are far behind the main line, for example 1,920 commits behind. For those, "files changed compared to main" includes every file that changed on main since the branch was made. That is close to a million characters of file names for a single branch. On the Mac Studio the report reached 314 MB, and the agent rewrote it every five minutes.

Rewriting a file that size takes about 0.7 seconds, during which the server can do nothing else. It also writes about 90 GB a day to the disk and keeps a 300 MB copy in memory. Nothing reads the long list: the only place that shows it prints the first five names and "+N more".

## What changes

For each branch the report now keeps the first 50 changed-file names plus a count of all of them. The notice still shows five names and the correct "+N more", taken from the count. On the Studio the report should drop from about 314 MB to under 2 MB.

## Safeguards

- No branch is skipped or hidden. Every branch with unmerged work is still listed, with its true commit count and changed-file count.
- A revert brings back the old behaviour, and nothing is migrated or deleted. The next scan simply writes the smaller report.

## What needs deciding

Nothing. This is a small, reversible fix to a monitor, built through the Tier 1 path.
