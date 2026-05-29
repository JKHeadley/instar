# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Instar worktree creation now activates the Husky pre-commit shim in newly
created worktrees. A fresh worktree could previously have Git configured for
Husky and the tracked pre-commit script present, while still missing Husky's
generated local shim. That made commits skip the instar-dev gate until someone
remembered to run the package prepare step in that worktree.

The worktree manager now verifies the generated shim after creating a worktree.
When the project has Husky configured, it runs the package prepare step if the
shim is missing, then fails loudly if the hook is still not runnable.

## What to Tell Your User

- **New worktrees start with the quality gate active**: "When I create a new Instar worktree, I now make sure its pre-commit gate is actually installed before using it. If the gate cannot be activated, I stop instead of silently working in an ungated checkout."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Worktree hook activation | Automatic when creating Instar worktrees with the built-in worktree command |

## Evidence

Dogfooding found worktrees with Git configured for Husky but missing the
generated hook shim, so commits bypassed the instar-dev precommit gate. Focused
unit coverage checks the runnable-shim predicate, and integration coverage
creates a real worktree and asserts the generated pre-commit shim exists and is
executable before worktree creation returns.
