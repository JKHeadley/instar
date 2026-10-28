# Feedback executor generated output: side effects

- Scope: only `buildChangeSet` skips six exact paths when absent from the trusted publish clone. It does not alter sandbox permissions, the 200-file/4-MB cap, source checkout, test execution, secret scan of publishable changes, review authority, or auto-merge policy.
- Security boundary: the walk still rejects symlinks, hard links, devices, and nested `.git` paths before skipping output. A file already in the publish clone is compared and published or rejected normally. Other `.instar/` and `src/data/` files remain visible. Skipped bytes never enter the publish clone or PR.
- Recovery: revert this change if one of the six paths becomes intentional publishable source; the older behavior will reject affected spec drafts rather than publish extra files.
- Evidence: the live rejected change-set path list is in `.instar/logs/feedback-triage.jsonl` at 2026-10-28 12:46:24 UTC. Unit regression passes 51/51; broader verification is pending.
