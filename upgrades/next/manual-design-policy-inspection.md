# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Added `instar design:inspect`, a manual comparison of committed Design Standard rules and screen registration against an explicit trusted base. It preserves base registrations and permanent rule history, and reports earned wording changes for independent review. It does not activate the visual merge gate or authorize a merge.

## What to Tell Your User

The design project now has a manual source checker. It can identify affected screens and changes to feedback-earned rules, while clearly saying that visual checks and merge enforcement are still separate work.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Manual design policy observations | `instar design:inspect --repo PATH --base BASE_COMMIT --head HEAD_COMMIT` |

## Evidence

Unit, real-Git integration and packaged CLI lifecycle tests cover the inspection's stated scope. The command does not claim any screenshot, accessibility, release or complete gate proof.
