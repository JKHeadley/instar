# The merge watcher asked GitHub a question it could not answer — plain-English overview

**What went wrong.** Before the background watcher merges one of our own green pull requests, it re-reads the PR from GitHub one last time, using the `gh` command-line tool. That read asks for a short list of fields. One name on the list, `mergeCommitOid`, is not a field `gh` knows. `gh` answers "Unknown JSON field" and fails. The watcher's code treated any failure of that read as "this pull request no longer exists" and skipped the PR. Since the bad name was on every read, every pull request looked deleted, and the watcher merged nothing. This was found on 2026-10-24 while PR #2334 sat green and unmerged; the watcher's log shows "skipped: vanished" for it on every pass.

**What changes.** The read now asks for the field `gh` actually has, `mergeCommit`, and takes the commit id out of it. Everything downstream still receives the same shape it did before, so nothing else had to change. Two guards were added so this cannot happen quietly again. First, a unit test checks the watcher's field lists against the list of fields `gh` supports (copied from `gh` 2.97.0's own help), with no network involved; a wrong name now fails the test suite. Second, if the installed `gh` ever rejects a field at runtime, the watcher reports it loudly through the normal degradation channel and its log, naming the field, instead of silently pretending the PR vanished. The read still fails in the safe direction: a rejected read never merges anything.

**What does not change.** The rules for what may merge are untouched: holds, the lease, the code-owner wait for constitution files, the independent second-pass review for protected files, and safe-merge's own checks all still apply. A pull request that really has been deleted is still skipped as vanished.

**What was checked and ruled out.** Other code in the repo uses the name `mergeCommitOid` for its own internal records (initiatives, project rounds). None of it sends that name to `gh`. The three other places that read the merge commit from `gh` already use the right field name.

**Safeguards and rollback.** The change reads one differently named field and adds a report; it writes nothing new and needs no migration. Reverting the commit restores the old behaviour, which is the broken one, so the rollback would bring the incident back.

**What you need to decide.** Nothing. The watcher goes back to doing what it was built to do: merge green pull requests without anyone having to click.
