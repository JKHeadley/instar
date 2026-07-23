---
title: "Session-pool promotion activation"
slug: "session-pool-promotion-activation"
author: "Instar Agent (instar-codey)"
parent-principle: "Structure beats Willpower"
status: "approved"
approved: true
approved-by: "Justin via Slack C0BA4F4E0FP, 2026-07-23"
review-convergence: "2026-07-23T10:53:00Z"
review-iterations: 1
review-completed-at: "2026-07-23T10:53:00Z"
cross-model-review: "codex implementation and boundary review"
eli16-overview: "session-pool-promotion-activation.eli16.md"
single-run-completable: true
---

# Session-pool promotion activation

## Problem

The evidence store, stage advancer, and rollout driver were merged, but no boot
path invoked promotion. The system could demote after a failed gate but could
not climb after a recorded green result.

## Contract

1. Add `multiMachine.sessionPool.promotionModel` with exactly `auto-climb`,
   `operator`, or `off`; missing or invalid values resolve to `off`.
2. Keep the default fully dark. A separate `promotionCeiling` defaults to
   `dark`, so choosing a model alone grants no promotion authority.
3. In `auto-climb`, invoke the existing rollout driver at a cadence no faster
   than 60 seconds. Each tick can advance at most one evidence-gated stage.
4. In `operator`, do not schedule automatic promotion.
5. `POST /session-pool/promote` invokes the same one-step driver in both live
   models and returns 503 while off.
6. Reuse the signed E2E result store and `StageAdvancer`; do not create a second
   source of stage truth or bypass its commit-bound green requirement.
7. The driver must never advance beyond the configured ceiling.
8. Preserve the existing demotion reconcile loop independently of promotion.

## Rollback

Set `promotionModel` to `off` or revert the additive wiring. No data migration
is required; the existing stage and signed result stores remain authoritative.
