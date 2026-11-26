# Give large worktree checkouts enough time

A worktree is a separate copy of the source code where an agent can make changes without disturbing other projects. Creating one checks out the repository's files. Instar's repository now contains about 28,000 tracked files, so that copy can take longer than 30 seconds, especially while a computer is recovering from a reboot or doing other disk work.

The managed worktree helper currently gives this large operation the same 30-second limit used by ordinary Git commands. When that limit expires, Git is stopped and the requested working copy may be left incomplete. The dashboard's Accounts work hit that problem. Its unregistered partial copy was checked against its intended commit: every present source file matched and there were no extra files. It was then removed through the audited filesystem executor, while preserving its branch.

This change gives only the worktree checkout up to five minutes. It keeps a finite deadline and preserves the general Git timeout for all other operations. Existing source-tree protection, capacity checks, creation locking, identity setup, hooks and audit records still apply. If five minutes is insufficient, creation still fails rather than reporting success or trying repeatedly. Failure cleanup is unchanged; this patch does not automatically delete a partial working copy.

The tradeoff is that a slow checkout can hold the per-agent creation lock for longer. That is bounded by the checkout deadline, and the lock is released when creation exits. The tests model a checkout that needs 45seconds at the real executor boundary, then perform actual Git operations in isolated repositories. They cover both creating a new branch and checking out an existing one, ordinary-operation timeout preservation, and failure handling. These are checks of the configured budget and wiring, not a claim that a timed 45-second disk copy ran in the test.

This is a small reversible repair. It adds no setting, API or permission. A normal revert restores the earlier limit. Complete coordinator verification is required before release, and no running installation is patched as part of preparing the change.
