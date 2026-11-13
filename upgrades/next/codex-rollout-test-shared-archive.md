# The Codex rollout lookup test builds its 25,000-file archive once

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

Test only. `tests/unit/codexRolloutLookup-bounded.test.ts` had four tests that each created and deleted the same beyond-the-sync-budget archive (25 partitions x 1000 rollouts). They now share one copy, built by the first test that needs it and removed in `afterAll`. The two tests that add a rollout to it remove that rollout in a `finally` block. No assertion changed.

## Evidence

Full Local Verify run of PR 3097 on the Studio, 2026-11-12: this file took 363.1 s, the slowest of 3,598 unit files (per-test: 149.6, 87.3, 68.0 and 36.7 s for the four archive tests). Run alone on the same machine: 34.5 s of test time before, 3.4 s after (three runs: 3.4, then two repeats, all 20 tests passing).
