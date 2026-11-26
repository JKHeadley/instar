# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Safe merge checks for open dependent pull requests before merging a parent. It retargets confirmed dependents to main so they survive deletion of the parent's branch.

## What to Tell Your User

Pull requests built on top of another pull request can stay open when the parent merges.

## Summary of New Capabilities

The merge tool manages the dependent PR base change automatically. Existing checks still apply.

## Evidence

A live timeline recorded deletion of the old base followed by closure of a dependent PR. Focused tests cover ready and draft dependents, multiple pages, changed heads, unreadable results and unconfirmed retargets.
