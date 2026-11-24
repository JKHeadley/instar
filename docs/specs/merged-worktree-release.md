# Release merged worktrees after 24 hours idle

Extend the existing agent worktree reclaimer. A registered checkout becomes eligible 24 hours after the later of its PR merge or last verified checkout activity. Verify the exact HEAD against the merged PR, including squash merges. Hold when provenance or activity evidence is missing. A new HEAD or new activity resets eligibility.

Require clean Git status including untracked files. Hold owner-reserved, locked, unreadable and nested worktrees, live session and process directories, build and index markers, and incoming dependency links. Preserve branch refs, backups and bundles. Recheck these guards under the existing reclaimer lock immediately before removal.

Allow recognized rebuildable dependencies and build outputs to go with the checkout. Treat other ignored files as evidence by default. Before removal, write one compressed archive per checkout under `.instar/backups/released-worktree-residue/` and record its source HEAD, manifest, byte count and SHA-256. Verify the archive contents against the source and publish the archive atomically. Hold the checkout on insufficient space, archive failure or changed content. Retain completed archives unless the owner approves their deletion.

Use non-forced Git worktree removal through SafeGitExecutor. Make retries idempotent and report per-path decisions, archive checksums and measured disk change. Start in dry run. Keep the storage alert open while the threshold is exceeded.

Cover exact merge and squash provenance, the 24-hour boundary, active use and owner holds, shared dependencies, and archive failure and races. Use real disposable Git worktrees for integration and the normal schedule for lifecycle verification. Route full verification through Throughput.
