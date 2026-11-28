# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The instar-dev commit gate's decision record (`.instar/instar-dev-decisions/<ts>-<slug>.json`) now keeps the context of the tier call, so the call can be graded later (docs/specs/judgment-call-rating.md, Part A). Each record gets a top-level `headCommit` and a `judgment` block (version 1) built by the new pure module `scripts/lib/judgment-context.mjs` from the same trace as the record's other fields: the tier reasoning (secret-scanned over the whole text, bounded to 4,000 characters), the trace's and artifact's git object ids, the spec's and its convergence report's staged ids (Tier 2+ only), the side-effects template's id, which required template headings the artifact has, the second-pass status mapped from the trace, and per-file lines with HEAD and staged blob ids. A failure to build the block is recorded as `judgment.error` and never refuses a commit. One new refusal: a commit that passed every check but whose decision record could not be written or staged is refused, and a record left behind reads `blocked`. The in-scope rule moves unchanged to `scripts/lib/instar-dev-scope.mjs`. The trace writer and the instar-dev skill now say the tier reasoning is copied into the public record.

## What to Tell Your User

Nothing changes for you. This only affects how Instar's own development commits are recorded.

## Summary of New Capabilities

Each Instar development commit's record now carries what is needed to grade its tier call later.

## Evidence

tests/unit/judgment-context.test.ts covers each block field, the second-pass mapping, heading matching, the whole-text secret scan, the bound and the never-throw builder. tests/unit/instar-dev-precommit-audit-staging.test.ts runs the real hook: a passing Tier 1 record carries `headCommit` and a block from the same trace with headings from the real template; a passing commit whose record cannot be written, or cannot be staged, is refused; a blocked one stays blocked. tests/unit/instar-dev-precommit-deferrals.test.ts covers the Tier 2+ call site with the spec and its convergence report. Whole-file runs on the exact tree (2026-11-28 01:00 PT, through the M5's heavy-turn wrapper): 17 unit files that touch or pin the gate, the trace writer and the scope rule, 1,204 tests, all passing. The two integration tests and the end-to-end test that run the gate are not run by hand on the M5; they run on the shared test line.
