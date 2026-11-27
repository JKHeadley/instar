# Side-Effects Review — Fixture guard comparison base

**Version / slug:** pre-push-fixture-canonical-base
**Date:** 2026-11-26
**Author:** Echo

## Summary of the change

The fixture guard compares HEAD with remote main when available. The unit regression exercises a tracked feature branch that merges main, then adds a new fixture commit.

## Decision-point inventory

The existing fixture signature check still controls the pre-push exit code. This change corrects the commit range submitted to that check.

## 1. Over-block

A stale local main ref can still cause the guard to inspect a commit that the remote already contains. With an up-to-date ref, commits proven reachable from main are excluded. A feature-only commit whose legitimate subject matches a listed signature can still be flagged by the existing policy.

## 2. Under-block

An unrecognized fixture signature still passes the existing matcher. A missing main ref retains the previous upstream fallback. CI repository invariants remain the second check for fixture files reaching main.

## 3. Level-of-abstraction fit

The pre-push hook owns the local check. Git determines reachability using the exact base and head. This belongs alongside the existing range selection.

## 4. Signal vs authority compliance

[Signal vs Authority](../../docs/signal-vs-authority.md) applies to the existing guard. The patch changes its input using deterministic Git reachability. The ratified test-environment isolation spec defines the existing blocking policy and signatures.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The boundary is whether the commit is reachable from the remote main ref.

## 5. Interactions

The guard still runs before smoke tests. Its Git reads use local objects and refs. CI repository invariants are independent of local ref freshness.

## 6. External surfaces

The change affects developers and agents pushing feature branches. It requires no remote API calls and modifies no service state. The diagnostic identifies the range when a fixture signature is found.

## 7. Multi-machine posture

The hook runs locally in each checkout. Each machine has its own fetched remote refs. There is no shared state to migrate.

## 8. Rollback cost

Revert the guard change. No data migration or repair is required.

## Second-pass review

**Reviewer:** fixture_review, independent guard review.

The reviewer concurred after the resolver adopted the release gate’s canonical remote order and a regression demonstrated that an alternate main ref cannot hide a feature commit.
