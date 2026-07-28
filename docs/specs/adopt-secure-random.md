---
title: "Adopt secure random for credential generation (external PR #1587 + completeness)"
slug: "adopt-secure-random"
author: "Echo (adopting external contribution by Marceli Pawlinski)"
parent-principle: "Structure beats Willpower"
status: "approved"
approved: true
approved-by: "Adopt-with-credit plan announced to operator in topic 29723 overnight queue, 2026-07-23; standing security-fix authorization"
review-convergence: "2026-07-24T04:20:00Z"
review-iterations: 1
review-completed-at: "2026-07-24T04:20:00Z"
cross-model-review: "External contribution (marceli1404) + Echo line-by-line review + full-tree completeness sweep + CI 8/8 unit shards on the external PR"
eli16-overview: "adopt-secure-random.eli16.md"
single-run-completable: true
---

# Adopt Secure Random for Credential Generation

Status: implemented in the same PR (behavior-preserving security hardening)

## Problem

Credential-generation sites (dashboard PINs, internal auth tokens) used
`Math.random()` — a non-cryptographic PRNG whose output is predictable given
observed outputs. External PR #1587 (Marceli Pawlinski) fixed five sites in
`src/commands/server.ts` and `src/monitoring/CoherenceMonitor.ts` but could not
pass the internal ceremony gates (fork PRs carry no decision trace), and its
sweep missed one site: `src/core/PostUpdateMigrator.ts` auto-generates a
dashboard PIN during migration with the same insecure pattern.

## Change

1. Cherry-pick #1587 preserving authorship (author remains Marceli Pawlinski):
   PIN sites → `randomInt(100000, 1000000)` (exact 6-digit range preserved);
   token sites → `randomBytes(16).toString('hex')` (32-char length preserved).
2. Fix the missed migrator site with the identical `crypto.randomInt` pattern.
3. Full-tree sweep confirms zero remaining credential-class `Math.random` uses
   (remaining uses are tmp-file suffixes, spawn ids, and store record ids —
   non-credential, deliberately left).

## Risk & migration surface

`PostUpdateMigrator` is fleet-rollout machinery (risk floor 2 — hence this
spec). The touched line runs only when `config.dashboardPin` is absent and
`authToken` present — the pre-existing trigger. Existing PINs and tokens are
never rewritten; only newly generated values use the CSPRNG. Output shapes are
byte-compatible, so no consumer, storage, or migration-path change exists.

## Verification

- External PR's unit shards: 8/8 green (node 20 + 22) before adoption.
- Local: tsc clean; 67 targeted migrator/PIN-adjacent unit tests green.
- Review: line-by-line diff read (20 lines), range/length equivalence checked
  per site.
