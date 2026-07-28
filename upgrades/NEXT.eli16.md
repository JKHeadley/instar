# vNEXT — plain English overview

## What this change is

The post-mortem this morning named five recurring bug classes. Four of
the five PRs landed today (#542, #545, #550, #551, #552) each closed
one specific incident — silent 403s, missing wiring, watch-exit
merges, bare catches. This is the fifth and final post-mortem PR, and
it closes the broader pattern that produced them:

**Tested on fresh state, not real-world state.**

That class is the one where the test suite passes because it uses
small, fresh, just-created fixtures, but the actual deployed agent has
a 202MB token-ledger.db / an externalized secret config / a
wrong-ABI binary / 8 concurrent jobs — and the boot path breaks in
production despite tests being green. Every fix-shape PR I named in
the post-mortem analysis had at least one test that PASSED on fresh
state and would have FAILED on real state.

This PR adds a new test category called `tests/real-world-state/`
specifically for that class. It sits alongside `unit/`,
`integration/`, and `e2e/` as a peer.

## What already exists

- The three existing test categories. None of them load real-shaped
  state — they all use small fresh fixtures (`tests/fixtures/`).
- Some adjacent code that COULD be tested at real-world state (the
  SecretMigrator + SecretStore have unit tests but their merge layer
  was never exercised end-to-end against the externalized shape until
  this PR).

## What's new

- A new directory `tests/real-world-state/`.
- A small framework helper (`_framework.ts`) with two things:
  - A two-tier system. Small/fast fixtures run on every PR. Big/slow
    fixtures (multi-100MB DBs, concurrency at scale) are gated on
    `INSTAR_REAL_WORLD_BIG=1` env, default off, so CI cost stays
    bounded.
  - A `makeAgentFixture()` helper that gives each test a real-shape
    on-disk agent home (`projectDir` + `.instar/`) for setting up the
    scenario.
- The first scenario: `externalized-config-boot.test.ts`. Five tests
  that target the #542 incident class — making sure `loadConfig()`
  correctly merges the real authToken back from the secret store when
  the on-disk config holds the placeholder. This is the in-process
  Node side of the bug; the existing PR #542 tests cover only the
  shell-script side.
- Vitest config updated to include the new directory.

## What you need to decide

Nothing. Test-only change. No runtime code modified. CI cost negligible
(the PR-tier fixture is tiny; nightly tier is opt-in).

## How to verify it worked after deploy

In CI, the new tests will appear in the unit-shard results as
`[real-world-state:pr] externalized-config-boot — ...`. The
`[real-world-state:nightly]` blocks (when added in future PRs) will
appear as "skipped (set INSTAR_REAL_WORLD_BIG=1 to run)".

Locally: `npm test` runs the PR tier. `INSTAR_REAL_WORLD_BIG=1 npm test`
runs everything.

## Why this matters more than it might look

This is the framework for catching the broader class. Future PRs will
add scenarios that target the other patterns I named in the
post-mortem:

- Multi-100MB token-ledger.db boot (catches the #534 class).
- Wrong-ABI better-sqlite3 binary swap (catches #539).
- Concurrent-job restart-during-tick (catches the class behind
  several silent-stop incidents).

Each future scenario follows the same `describeAtTier(...)` shape as
the first one. Adding the next one is small (~30 minutes of test
writing); designing the framework was the hard part and it's done.

This is the LAST recommended fix from the post-mortem. Six PRs in <7
hours total. The fix-rate of 19% over the last 14 days won't drop
overnight, but each of these closes a class structurally — which means
the rate drops the next time someone tries to ship one of those
patterns again, not because they remember to be careful but because
the lint or the test or the gate refuses to let them.
