# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Audits that must recur now have a register, docs/audits/required-audits.json. Each row names an audit, its owner, its cadence and its first due date. A new commit-time check fails only when the register itself is malformed, or when a row is moved later, lengthened or removed against main's copy without a recorded reason. Every audit that never started or is overdue is named on every run, and a weekly nonblocking workflow keeps one tracking issue open while any has lapsed.

## Evidence

tests/unit/lint-required-audits.test.ts covers both sides of each boundary. On the real tree it reads 7 rows, and 4 have lapsed.
