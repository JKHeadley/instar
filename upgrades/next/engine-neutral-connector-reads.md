# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

GitHub connector reads with names such as `github__fetch_pr` and `github_fetch_pr` were misclassified as modifications. The existing effect classifier and generated hook now recognize the actual read verb after the namespace, using the same engine-neutral rules. Mutations, compound read-and-write names, execution wrappers and unknown verbs stay governed. The normal update path replaces the shipped hook on existing agents and preserves custom hooks. No trust raise or account-specific exception is needed.

## What to Tell Your User

Routine GitHub reads no longer ask you to grant extra autonomy just because a session uses a connected tool. Changes such as pushes, comments and merges keep their existing approval rules.

## Summary of New Capabilities

No new permission or setting. This repairs classification of existing tools across engines.

## Evidence

Regression cases failed before the correction. Focused unit checks cover the server classifier and executed generated/migrated hooks; HTTP and production-server lifecycle checks cover admission and runtime reload. Complete repository verification runs through throughput before release.
