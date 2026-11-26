# Local-verify uses the installed merge tool — the plain-English version

The new local-verify feature has a loop that decides what pass/fail mark each pull request should get. To decide that the same way the merge tool does, it borrows the merge tool's own rules from its file, `scripts/safe-merge.mjs`, instead of keeping a second copy that could drift.

The bug: it borrowed that file from the wrong place. It read it from the agent's working folder, which is a git checkout that can be sitting on any branch with any unfinished edits. On the first day after release, that folder held an older merge tool from before this feature existed, so the loop found none of the rules it needed and quietly did not start. The status page said "not configured".

The fix: the loop now reads the merge tool that ships inside the installed Instar package, right next to the code that is actually running. That copy always matches the running version, and nobody edits it by hand. The design always said the trusted side of this feature must come from the installed copy; this one place had missed it.

Nothing changes for users: the feature is still switched off, and this only lets its watch-only mode start. The same mistake exists in the older auto-merge watcher, which also runs the merge tool from the working folder. That is recorded as its own task, to be fixed before merges are ever switched to trust local test runs.
