# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The standards back-reference check now covers decision infrastructure (files named as guards, gates, sentinels and similar, plus lint checks and hooks), not only the files the standards registry cites. Existing gaps are recorded in a shrink-only baseline, and new files must name the standard they enforce. This is a repository development check only; agents' runtime behaviour does not change.

## What to Tell Your User

Nothing; this only affects how Instar itself is developed.

## Summary of New Capabilities

None at runtime.

## Evidence

Thirteen new tests in tests/unit/lint-standard-code-backreference.test.ts, 23 of 23 passing. On the real tree, the check covers 288 more files: 21 already compliant and 267 baselined, with every entry checked against main's copy and the list's size and exact entries pinned in the lint.
