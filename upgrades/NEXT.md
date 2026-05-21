# Upgrade Guide — v1.2.9 (nuke --here leftover-artifact fixes)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Fix: `nuke --here` now leaves no leftovers.**

End-to-end testing of the v1.2.8 nuke --here flow on a fresh project
turned up two artifacts the teardown forgot:

1. The `.gitignore` instar writes during install was orphaned after
   nuke. Fixed by routing it through the existing identity-shadow
   classifier (tracked-clean keep, tracked-modified restore,
   untracked delete) — same rule we already apply to the identity
   shadow files.

2. The `.instar/` directory ghost-revived itself after delete. The
   SafeFsExecutor and SafeGitExecutor audit log lives at
   `.instar/audit/destructive-ops.jsonl`. When `.instar/` was deleted
   early in teardown, every subsequent destructive op wrote an audit
   entry into a freshly-recreated `.instar/audit/`. Fix: reorder
   teardown so `.instar/` is last, and suppress audit logging for
   that single delete via the existing `INSTAR_AUDIT_LOG_DISABLED`
   env contract. The agent dir is going away in the same breath, so
   the suppressed entry has no downstream consumer.

Three new unit tests pin the corrected behavior end-to-end against
tmpdirs: instar-created `.gitignore` is deleted, pre-existing
tracked `.gitignore` is preserved, and `.instar/` is fully absent
after nuke (no `audit/` carryover).

Spec: `specs/dev-infrastructure/nuke-here-leftovers.md`.
ELI16: `specs/dev-infrastructure/nuke-here-leftovers.eli16.md`.
Side-effects review: `upgrades/side-effects/fix-nuke-here-leftovers.md`.

## What to Tell Your User

Uninstall now actually leaves the project the way it was before
instar was installed. There is no orphaned per-machine ignores file
and no ghost configuration directory left behind. If you run the
install/uninstall/reinstall loop a dozen times in a row, each cycle
starts from the same clean state as the first.

## Summary of New Capabilities

No new capabilities. Behavior fix on top of v1.2.8.

## Evidence

Reproduction prior: ran `npx instar@1.2.8 init <name> --framework
codex-cli` followed by `npx instar@1.2.8 nuke --here --yes`. On-disk
state after nuke: `.gitignore` present with instar's per-machine
ignores; `.instar/` present containing
`audit/destructive-ops.jsonl`. Three explicit unit tests now cover
both observations and fail on v1.2.8, pass on v1.2.9.
