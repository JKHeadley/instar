# Git Maintenance Promotion

<!-- bump: patch -->

## What Changed

Promotes the agent git maintenance infrastructure from a Codey-local dogfood tool into shared Instar distribution. New and upgraded agents receive the framework-neutral maintenance helpers, a built-in AgentMD git-maintenance job, and overseer coverage for that job. The default behavior is audit-only and non-blocking; the bounded repair mode remains explicit and only removes safe ignored/generated paths from the git index while leaving files on disk.

## What to Tell Your User

Your agents now have built-in git hygiene maintenance. They can audit their own repository state, identify local runtime clutter that should not be tracked, and keep the signal around source changes cleaner. The normal scheduled path only reports; any repair still needs explicit authorization and does not delete local files.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Fleet git maintenance audit | Automatic built-in AgentMD job for new and upgraded agents |
| Existing-agent script deployment | Automatic during the post-update migration |
| Safe index-only repair path | Explicit operator-authorized maintenance action |

## Evidence

Verified on the current release line after rebasing onto main: script syntax checks passed; lint passed; focused fresh-install, migrator, built-in manifest, package template smoke, and default-job tests passed with 5 files and 49 tests green. The direct maintenance audit was also exercised during dogfood before promotion and confirmed the default path reports findings without mutating repository state.
