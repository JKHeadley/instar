# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The back-reference check's list of known gaps (guards that do not yet name a standard) can no longer grow by any route. Every entry must already be in main's copy of the list, so a change can only remove entries, even while it swaps others. The list's size (267) and its exact entries are pinned in the check as a second layer. Guard words now match whole words of a file name, including gateway, plurals and compounds such as safeguard. This drops one false match, so the list goes from 268 to 267.

## Evidence

Nine new tests in tests/unit/lint-standard-code-backreference.test.ts, 25 of 25 passing. On the real tree, the check covers 288 more files: 21 already compliant and 267 on the list, with every entry checked against main's copy.
