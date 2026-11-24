# Release merged worktrees after 24 hours idle

Extend the existing agent worktree reclaimer. A registered checkout becomes eligible 24 hours after the later of its PR merge or last verified checkout activity. Verify the exact HEAD against the merged PR, including squash merges. Hold when provenance or activity evidence is missing. A new HEAD or new activity resets eligibility.

Require clean Git status including untracked files. Hold owner-reserved, locked, unreadable and nested worktrees, live session and process directories, build and index markers, and incoming dependency links. Preserve branch refs, backups and bundles. Recheck these guards under the existing reclaimer lock immediately before removal.

Allow recognized rebuildable dependencies and build outputs to go with the checkout. Treat other ignored files as evidence by default. Before removal, write one compressed archive per checkout under `.instar/backups/released-worktree-residue/` and record its source HEAD, manifest, byte count and SHA-256. Verify the archive contents against the source and publish the archive atomically. Hold the checkout on insufficient space, archive failure or changed content. Retain completed archives unless the owner approves their deletion.

Use non-forced Git worktree removal through SafeGitExecutor. Make retries idempotent and report per-path decisions, archive checksums and measured disk change. Start in dry run. Keep the storage alert open while the threshold is exceeded.

Cover exact merge and squash provenance, the 24-hour boundary, active use and owner holds, shared dependencies, and archive failure and races. Use real disposable Git worktrees for integration and the normal schedule for lifecycle verification. Route full verification through Throughput.

## Report-only implementation boundary

Add an independent default report-only policy. For checkouts enrolled in this policy, the legacy reaper must defer to it even when legacy deletion is enabled. The first implementation must have no route from this policy to archive creation, deletion, or cleanup callbacks. Existing unenrolled worktrees retain their existing behavior.

Bind evidence to a canonical repository, worktree registration, and exact HEAD. Read the PR's exact final head and merged timestamp from the repository's trusted upstream. Stale tracking refs and patch equivalence cannot establish eligibility. Where an ancestor is allowed, require authoritative evidence linking that exact commit to the merged change. A fresh merged record can be cached with a bounded lifetime, but a changed registration or HEAD invalidates it immediately.

Record the start of continuous observation and last known session or build activity using the existing lifecycle signals. Start the clock at observation time if past activity cannot be established, and reset after a monitoring gap that could conceal activity. Filesystem changes and live processes can extend a hold. Their absence cannot establish past idleness. Bound per-pass work using the existing worker deadline and scan budgets, resume incomplete scans, and treat incomplete checks as holds. Report-only reads metadata and status without reading archive payloads.

A later deletion implementation needs a per-checkout claim shared with session and build admission and dependency registration. Hold if unmanaged writers cannot be excluded. Restrict archive entries to relative paths inside the checkout, preserve symlinks without following them, and hold on special files, nested repositories, or backup and bundle collisions. Use private permissions and never overwrite a completed archive. Verify the source manifest again while the claim is held before removing the checkout.

## Multi-machine posture

Checkout observation, removal claims and recovery archives live on the host that owns the checkout. machine-local-justification: hardware-bound-resource

Expose report decisions through the existing host-qualified reclaimer status and use the existing pool reporting path for summary visibility. A report on one machine grants no authority over another machine's checkout.

## Decision points touched

- Minimum idle time — invariant; basis: external-constraint; evidence: the requested 24-hour policy applies before any checkout can be released.
- Exact merge identity and activity evidence — invariant; basis: irreversible-consequence; evidence: a stale ref or observation gap could authorize deletion of unpublished or active work.
- Owner holds, locks, dependencies, and archive integrity — invariant; basis: irreversible-consequence; evidence: a deletion can destroy local evidence or break a dependent checkout. Unknown inputs hold.
- Report-only rollout and later activation — invariant; basis: irreversible-consequence; evidence: a dry-run verdict cannot authorize an archive write or deletion. Any future destructive mode needs separate activation.

## Enrollment, observation and rollback

Enroll through an explicit host rollout setting scoped to the existing registered worktree roots. Ship with enrollment off, then enable report-only on the test host and Studio as separate operator actions. On an enrolled host, reserve all supported registered checkouts before legacy eligibility runs, even while merge lookup is unavailable. Enrolled checkouts remain reserved on a partial scan or unreadable state. Keep observation active when legacy removal is disabled. Rollback stops observation but preserves the reservation until an explicit operator decision restores legacy custody.

Use durable session and build admission and exit events keyed by checkout generation. A short session between scans must reset the idle clock. Require a continuous event cursor and reset observation after a missing range, unknown restart continuity, path reuse, or a backward clock adjustment. Advance partial scans with a bounded resume cursor. Never backdate idle time to a commit timestamp. The 24-hour floor governs automatic eligibility only; separately authorized manual handling follows its own guards.

Before proposing any destructive rollout, review at least one full observation window on the test host and then the Studio, including missed and unexpected candidates. Verify reporting works with legacy deletion disabled and cannot call cleanup callbacks on a legacy-armed host when upstream evidence is missing. A later retry after archive publication must reacquire the checkout claim and verify the current manifest matches the completed archive. If it differs, preserve both and report the hold.

At enrollment, reserve the supported roots before reading Git registration. An unreadable or unregistered path discovered under a reserved root receives a hold verdict. Persist root custody independently of any individual activity row, so a failed registration lookup or lost cursor cannot route the path to legacy removal. The idle calculation includes the first observation of the current HEAD alongside merge time and the last activity event.

Emit the checkout generation's admission record in the session and build admission paths before a runner receives the checkout, and record exit in their normal teardown paths. A failed start-record write must prevent that checkout from being treated as continuously observed. An unmatched start holds it. If an entry point cannot provide durable coverage, keep the checkout ineligible. Test short sessions wholly between scans, write failures, unreadable registration on first discovery, and a HEAD change just before expiry.

The archive contains only non-rebuildable ignored entries and a manifest of that exact set. Tracked files remain recoverable through Git. Rebuildable ignored output stays out of the archive. Untracked non-ignored files hold removal. Test the archive against a checkout with all three file classes.
