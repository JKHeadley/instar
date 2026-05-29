---
title: TokenLedger 503 Alive Regression Guard
review-convergence: 2026-05-29T10:30:00Z
approved: true
eli16-overview: tokenledger-503-alive-regression.eli16.md
---

# TokenLedger 503 Alive Regression Guard

## Problem

Two separate TokenLedger recovery fixes restored `/tokens/*` after real 503 failures:

- old SQLite files created before token attribution existed needed the `attribution_key` column added before any index referenced it;
- native sqlite healing needed a later sqlite subsystem to retry after an earlier subsystem had already completed a successful rebuild in the same process.

Both fixes had unit coverage, but the endpoint-level safety gap remained: a future edit could keep a unit test green while the HTTP route regressed to 503. The Testing Integrity Standard requires an alive-path guard that proves the feature surface returns data over the route after recovery.

## Proposed Change

Add an integration test that builds a fresh old-shape TokenLedger database, opens it through the real TokenLedger constructor, wires it into the real Express token route, and asserts `GET /tokens/summary` returns HTTP 200 with the seeded data.

In the same harness, exercise the shared native-heal retry path without running a rebuild. The test simulates another subsystem consuming the one-per-process heal successfully, then opens TokenLedger through a constructor seam whose first database open throws a `NODE_MODULE_VERSION` error and whose retry returns a real SQLite handle. The route must still return HTTP 200 with data, and the rebuild spy must show no second rebuild attempt.

## Acceptance Criteria

- A freshly seeded old pre-attribution database without `token_events.attribution_key` migrates during TokenLedger construction.
- `/tokens/summary?since=0` returns HTTP 200 and the seeded totals, not 503 or an unavailable error.
- The migrated database contains `attribution_key` after open.
- A prior successful heal by another sqlite subsystem lets TokenLedger retry and open without a second rebuild.
- The shared-heal case also proves the HTTP token summary route is alive.

## Decision Points

This change adds no runtime decision point. The only production change is a constructor dependency seam used by tests; production still constructs `better-sqlite3` the same way. The route's existing 503 behavior for a missing ledger is untouched.

## Rollback

Rollback is a normal code revert. The test seam does not write persistent state or change database schema behavior. Removing the test returns coverage to the prior unit-only state.
