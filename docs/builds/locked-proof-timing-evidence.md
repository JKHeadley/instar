# Build: locked-proof timing evidence

Tier 1 / SMALL. Parent initialized build state and created isolated worktree topic-138345-proof-timing from 8a5204ad8, branch fix/locked-proof-timing-evidence. Origin and upstream are https://github.com/JKHeadley/instar.git; package version 1.3.1885. Shared identity is Instar Agent (echo). No changes in the agent-home checkout.

Problem: optional extra timing fields let before-Enter cases pass without measured order. Plan: calculate a finite raw same-duty completion gap inside the judge, capture approved grant identity, reject unknown timing, add adversarial simulated tests. Product and native safety authority stay unchanged. Parent owns the separate 12.8 correction.

Acceptance: all four before-Enter cases reject missing/late/equal/non-finite/conflicting timing and forged extras; valid negative raw timing passes; after-Enter cases retain behavior; missing Enter remains unmeasured even when aborted and zero submissions. Recovery and native dispatch do not change. Tests are targeted only, at most five unit files per run. Full suites are reserved for the merge owner's Local Verify line.

Review: parent independent rereview concurs; no remaining blocker. Local commit authorized after fast guards and fresh Tier 1 trace. Parent owns push/PR. Rollback: revert harness change, no migrations or restarts. Evidence limitations are stated in the ELI16 and side-effects artifact.

Initial validation: 90/90 targeted tests passed in tests/unit/locked-proof-driver.test.ts and tests/unit/locked-proof-timing.test.ts. git diff --check passed. No live Mac actions or integration/E2E runs.

Parent review refinement: require finite start <= completion < Enter for non-deadline interruptions. An early start with a late response is insufficient. Deadline continues to use approved expiry. New tests cover late completion, missing/non-finite completion, inverted intervals, and deadline independence.

Final targeted validation after completion-bound correction: 92/92 tests passed across the two proof driver/timing unit files. git diff --check passed.

Required fast guards: all 30 files passed in six sequential batches of at most five files (802 passing tests). Batch logs: /tmp/topic138345-timing-guards-1.log through -6.log; manifest: /tmp/topic138345-timing-guards-summary.json. Main 0a7724de4 is an ancestor of the reviewed base.
