---
title: "Session-pool stage attribution"
slug: "session-pool-stage-attribution"
author: "Instar Agent (instar-codey)"
parent-principle: "Structure beats Willpower"
status: "approved"
approved: true
approved-by: "Justin-directed Echo dispatch, 2026-07-23"
review-convergence: "2026-07-23T19:48:00Z"
review-iterations: 1
review-completed-at: "2026-07-23T19:48:00Z"
cross-model-review: "Echo live evidence plus Codex boundary review"
eli16-overview: "session-pool-stage-attribution.eli16.md"
single-run-completable: true
---

# Session-pool stage attribution

## Problem

The stage advancer read the live config-backed stage, but the failover proof
producer always recorded stage zero. After the pool reached live transfer, a
passing check could never satisfy the stage-two gate needed for rebalance.

An npm installation may also lack a Git checkout. Both sides fell back to the
literal identity `unknown`, which remained internally consistent but discarded
an available package-version identity.

## Contract

1. Define one config-backed stage reader in server boot wiring.
2. Give that same reader to StageAdvancer and derive the runner's recorded
   stage index from it at tick time.
3. A green records against the current stage and can unlock only the next
   evidence-gated promotion.
4. Re-read the stage after the check and record nothing if it changed while the
   check was running.
5. A green at any other stage cannot unlock the current-stage climb.
6. Define one shared build-identity closure for producer and consumer.
7. Resolve identity from an explicit deployment SHA, then the exact checkout
   exercised by the runner, cwd Git HEAD, running package version, and finally
   `unknown`.
8. Preserve equal-`unknown` comparison behavior for legacy/no-metadata installs.
9. Preserve dry-run isolation, signed evidence verification, and one-step
   promotion ceilings.

## Rollback

Revert the additive wiring and boundary tests. No stored data migration is
required; existing signed rows remain valid and stage writes remain controlled
by StageAdvancer.
