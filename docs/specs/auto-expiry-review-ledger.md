---
title: Auto-expiry review ledger and honest eligibility (CMT-1118)
slug: auto-expiry-review-ledger
tier: 1
eli16-overview: docs/specs/auto-expiry-review-ledger.eli16.md
---

# Auto-expiry review ledger and honest eligibility

## Problem

Two sweeps close stale records: `commitments.autoExpiry` (CommitmentTracker) and
`evolutionActions.autoExpiry` (EvolutionManager). Both ship `dryRun: true`, and
the rule for turning dry-run off is "review what it would expire". The
2026-10-28 feature-maturation review found neither can meet that rule:

1. A dry-run sweep logs only aggregate counts (`eligible=412`, `eligible=44`).
   The ids it would expire are written nowhere, so nobody can review them.
2. The commitment agent-branch predicate ignores `blockedOn` and
   `followThroughOptOutReason`. Measured on this agent: 412 eligible of 1116,
   14 of them `blockedOn: external` (owned by the external-block dead-letter
   path), 21 created with an explicit opt-out reason. Its resolution text,
   "aged out >21d, presumed completed-but-unclosed", claims completion from age.
3. The evolution sweep (44 eligible of 300) hard-deletes the record, and its
   eligible set is mostly real overdue work: 19 are `high` (which has its own
   undated resurfacer and overdue check) and 43 of 44 are dated actions merely
   past due.

## Change

### Durable review ledger (both sweeps)

New `src/core/AutoExpiryLedger.ts`. Each sweep appends one JSONL row to
`<stateDir>/logs/commitments-auto-expiry.jsonl` or
`<stateDir>/logs/evolution-actions-auto-expiry.jsonl`:

`{ ts, dryRun, maxAgeDays, scanned, eligible, expired, capped?, setHash, items: [{ id, ageDays, class, reason?, applied }] }`

`applied` on each item is the authority on what the sweep actually closed; the
row-level `dryRun` is the main branch's setting only (the commitment row also
carries `agentEnabled`, `operatorWaitEnabled`, `operatorWaitDryRun`).

- The full `items` list is written when the eligible set changes, on the first
  sweep after a process start, and on every sweep that actually expired rows.
- An unchanged dry-run set writes `{ ..., setHash, unchanged: true }` with no
  items, so a stable backlog is not rewritten four times a day.
- A set that drains to empty (and the first empty sweep after a process start)
  writes one `eligible: 0, items: []` row, so the last row never shows ids that
  are no longer eligible; later empty sweeps write nothing.
- At most 500 items per row (`itemsTruncated` counts the rest). One `.1`
  rotation past 5 MB. Append failures are logged and swallowed: the ledger never
  changes what a sweep does.
- The commitment row also carries the operator-wait branch's own
  `operatorWaitDryRun` / `operatorWaitMaxAgeDays`, and its rows appear with
  class `operator-wait`.

### Commitment agent-branch rule

A row is eligible only if it is agent-owned, `blockedOn` is `none` (absent
counts as none), open (`pending`/`violated`), locally originated (a row whose
`originMachineId` names another machine is left to that machine, as the
operator-wait branch already does), older than `maxAgeDays` measured from the
LATER of `createdAt` and `lastProbe.at`, and has no future `hardDeadlineAt`.

- `blockedOn: external` stays with the external-block dead-letter path.
- `blockedOn: user-input | user-authorization` stays with the operator-wait
  branch; when that branch is disabled the row stays open instead of falling
  through to the agent rule.
- Resolution text no longer claims completion:
  - class `opted-out` (created with a `followThroughOptOutReason`):
    `auto-expired after N days: created with no follow-through needed ("<reason>")`
  - class `no-activity`: `auto-expired after N days with no recorded activity;
    outcome unknown (not confirmed completed). Re-open it if it still matters.`

### Evolution rule (tightened)

Unchanged: only `pending`, never `critical`, never tagged `pinned`, created
more than `maxAgeDays` ago, invalid dates retained. New:

- `high` is retained like `critical`.
- A dated action must be overdue by more than `maxAgeDays` (due before the age
  cutoff), not merely past due — freshly overdue items are what the overdue
  check resurfaces.
- Ledger classes: `long-overdue`, `opted-out`, `undated`; an opted-out item
  carries its reason.

Measured effect on this agent's live queue: 44 → 17 eligible.

### Defaults and rollout

No default changes: both sweeps stay `dryRun: true`. The ledger is always on
(it is observability). Turning either dry-run off remains a deliberate operator
choice, now made against the ledger's ids.

## Awareness and migration

One appended CLAUDE.md bullet ("Auto-expiry review ledgers:") in
`generateClaudeMd`, `migrateClaudeMd` (content-sniffed) and the shadow-capability
markers. No config migration: no config keys change.

## Multi-machine posture

Machine-local by design. Each machine sweeps only its own records (the
commitment rule now skips other-origin rows), so each machine's ledger describes
exactly the rows it could expire.

## Tests

- Unit: `tests/unit/CommitmentTracker-auto-expiry.test.ts` (blockedOn external
  and user-*, opt-out wording, probe age, replicas, ledger full/unchanged/empty
  rows), `tests/unit/evolution-action-auto-expiry-ledger.test.ts` (high retained,
  overdue bound, classes, applied rows), migration parity test.
- Integration: `tests/integration/evolution-action-auto-expiry.integration.test.ts`
  asserts the applied ids land on the ledger.
- E2E: `tests/e2e/commitment-auto-expiry-api-lifecycle.test.ts` asserts the new
  resolution over the HTTP route and the ledger row.

## Rollback

Revert the PR. The ledgers are append-only logs; leaving them on disk is
harmless.
