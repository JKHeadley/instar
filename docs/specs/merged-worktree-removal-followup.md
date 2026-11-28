# Follow-up before enabling merged checkout removal

The first worktree release build reports only. Stewardship owns this follow-up. Require a separate converged design and opt-in before archive creation, removal, or legacy custody changes.

- Prove source provenance, durable activity and exact HEAD generation across restart, session admission and intermediate checkout changes. Resolve availability if recording fails. Reconcile already active runners before observing idle time.
- Serialize enrollment, final legacy removal, and session/build claims. Prove downgrade disables legacy removal before dropping custody support. Hold when unmanaged writers cannot be excluded.
- Verify clean tracked bytes, untracked status, links and dependency ownership. Preserve backups, bundles, holds and branch refs.
- Define archive entry identity; exclude only exact generated digests proven reproducible. Verify contained paths and archive bytes against the source manifest, including mixed build trees and changed content. Preserve verified archives on retry or refusal. Use non-forced guarded Git removal only after all checks.
- Validate on test and development agents, including crash and late-writer tests, before considering fleet rollout. Record measured disk change and retain archives.
