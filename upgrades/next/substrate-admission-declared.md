# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

A new development check: any new article filed in the standards registry's "Substrate" family must say how it passes the family's three admission tests. The 27 existing articles are recorded in a list that can only shrink, and a recorded reading of all 27 against those tests is added under docs/audits. This is a repository development check only; agents' runtime behaviour does not change.

## What to Tell Your User

Nothing; this only affects how Instar itself is developed.

## Evidence

Tests: tests/unit/lint-substrate-admission-declared.test.ts, 10 of 10. The lint reports 27 articles, all in the baseline.
