---
title: "Dark monitoring-route agent awareness"
slug: "agent-awareness-dark-monitoring-routes"
author: "Instar Agent (instar-codey)"
parent-principle: "Migration Parity"
status: "approved"
approved: true
approved-by: "Justin via Slack C0BA4F4E0FP, 2026-07-23"
review-convergence: "2026-07-23T09:10:00Z"
review-iterations: 1
review-completed-at: "2026-07-23T09:10:00Z"
cross-model-review: "codex independent capability_honesty review"
eli16-overview: "agent-awareness-dark-monitoring-routes.eli16.md"
single-run-completable: true
---

# Dark monitoring-route agent awareness

## Problem

`GET /pool/failover-gap` and `GET /pool/missing-login` already exist and already
have correct CapabilityIndex entries, but neither route is taught by
`generateClaudeMd` or `migrateClaudeMd`. Fresh and upgraded agents therefore
cannot discover these operational read surfaces from their identity guidance.

## Contract

For each route:

1. Export one shared CLAUDE.md section from `PostUpdateMigrator`.
2. Emit that exact section from `generateClaudeMd`.
3. Content-sniff its distinct heading in `migrateClaudeMd` and append only when
   absent.
4. State that the guard is signal-only, dev-gated and fleet-dark by default,
   returns 503 when not constructed, and defaults to dry-run when enabled on a
   development agent.
5. State that 503 is unknown health, while 200 plus `dryRun:true` means
   observation/would-raise counters without an Attention item.
6. Preserve the existing CapabilityIndex entries without duplication.
7. Prove a second migration is byte-identical and fresh generation uses the
   same shared text.

## Authority and rollback

This is additive awareness only. It changes no runtime guard, notification,
credential, recovery, session, or block/allow authority. Revert and ship a
patch; appended prose requires no state repair.
