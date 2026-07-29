# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The pull-request template now places each gate hint directly below the section
it explains. Its unit test asserts that adjacency instead of merely checking
that headings and guidance exist somewhere in the file.

## What to Tell Your User

Pull-request authors now see the ELI16 length guidance under ELI16 and the
exact-diff-string guidance under UX Impact.

## Summary of New Capabilities

- Structurally paired PR-template headings and gate hints.
- Regression coverage for both heading-to-hint relationships.

## Evidence

- The real template-gate test passes.
- Moving a hint back above its heading makes the adjacency assertion fail.
