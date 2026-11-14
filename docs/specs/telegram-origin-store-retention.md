---
title: "Telegram Origin Store Retention — replies are never held because of store size"
slug: "telegram-origin-store-retention"
author: "echo"
parent-principle: "Structure beats Willpower"
parent-spec: "telegram-message-origin"
eli16-overview: "docs/specs/telegram-origin-store-retention.eli16.md"
lessons-engaged: [P4-testing-integrity, P19-no-unbounded-loops, P20-verify-the-state, P21-multi-machine-entity, measure-the-fix-on-the-failing-workload]
source-topic: "10000001156"
approved: true
approved-by: "Echo under the operator standing rule that only constitution changes need Justin (2026-10-22, JKHeadley/instar); the retention limit is the operator request in topic 10000001156 to give every table bounded retention"
review-convergence: "2026-11-01T20:06:24.859Z"
review-iterations: 6
review-completed-at: "2026-11-01T20:06:24.859Z"
review-report: "docs/specs/reports/telegram-origin-store-retention-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

## Problem statement

The Studio's origin store, `.instar/state/pending-relay.echo.sqlite`, is 644 MB after 54 days and grows by about 1,000 operations a day. Measured on a read-only copy taken 2026-11-01: 55,943 origins (219 MB), 87,563 children, 88,890 materializations, 78,036 attempts, 569,331 metric events, and 18,662 archive files holding 25,677 records (1.4 records per file).

Operators see Telegram replies held with `execution-admission-unavailable` and `/telegram/origins/operations/:id/outcome` answering `origin-store-unavailable`.

**Measured cause.** Every store call runs on one worker thread, one at a time. `service.admit` gives `store.admit` a 1 s budget. So any slow call on that worker holds a reply, even though the admit SQL is quick. The retention tick (`maintainRetention`, at most once a minute) runs:

| Step | Warm | Cold page cache |
|---|---|---|
| `archive` candidate query | 3.0–6.1 s | 9.6 s |
| `cleanupPayloads` materializations | 0.1 s | 6.0 s |
| `cleanupPayloads` entries | 0.02 s | 5.3 s |
| `cleanupPayloads` expired list | 0.004 s | 1.8 s |
| admit: active-operation count (inside the transaction) | 0.003 s | 0.7 s |

Outside the tick, `getFederatedMetrics` takes 1.7 s (a full scan of 569k events). The archive query walks every row in `sequence` order, so it gets slower every day. The `request-stalled: cleanupPayloads` restart in health is the same class.

**Why one file per 1.4 records.** The tick archives whatever crossed the 30-day line in the last minute, however little that is.

## What each table must keep

| Need | Lives in | Needed for how long |
|---|---|---|
| Recovery | operations, children, materializations, entries, attempts, recovery schedule | Until terminal. A deadline is at most six hours after preparation, and past it `cleanupPayloads` expires the operation. |
| Content dedup | `OutboundContentDedup`, a separate store | Not an origin-store table. `findByTopicAndHashWithin` reads `entry_kind='legacy'` rows only, and those keep their existing purge. |
| Receipts and audit lookup | origin row, destinations, platform receipts | Parent spec item 11: metadata and receipts stay until the operator changes retention; older records live in indexed, manifest-backed archives. Archived records stay inspectable. |
| Audit detail | the origin audit record | The full `OriginAuditRecord` is already written to the archive file, including operation, children, attempts and verification. |
| Counters | `telegram_origin_metrics` | Forever; it is already one row per metric. `telegram_origin_metric_events` only exists to stop one event counting twice, and to feed federated counts. |

## Design

### 1. Queries stop depending on total size

- **Archive walks a cursor, not the table.** A new singleton table, `telegram_origin_retention`, holds `archive_after_sequence`. `archive()` reads forward from it by primary key, at most 2,000 rows a call, skips rows already archived, and stops at the first row that is too young. The eligibility line moves from 30 days to seven. A row that has to wait (not yet terminal, a reserved notice, a receipt still to fold in) holds the durable cursor where it is but does not stop later rows from archiving: the scan runs on past it and wraps round to it later. A row dated more than a day in the future counts as old, so a wrong clock cannot pin retention. An index on `archive_id IS NULL` was rejected: building it took 25 s on the copy, which is close to the 30 s worker startup limit.
- **`telegram_origin_operation_open`**: a partial index on `(kind,deadline_at,payload_bytes)` over non-terminal operations, which now counts `superseded` as terminal, so a superseded row no longer takes an admission slot or gets rewritten as expired. It serves the admit count and the expired list in time proportional to active work. It built in 0.2 s on the copy.
- **`telegram_origin_entries_text`**: a partial index on entries that still hold text, for `cleanupPayloads`. It built in 0.6 s.
- **Cleanup join order is forced** to start from the existing live-row partial indexes (`CROSS JOIN`, `INDEXED BY`), so the cost follows live rows, not all terminal operations.

### 2. Archives are batched, and old small ones are merged

- The runtime asks `archive()` for 100 records and sets `minRecords: 100`. Fewer candidates write no file, unless the oldest is more than seven days past the eligibility line, so a quiet agent still archives. Full detail therefore leaves the hot tables between 7 and 14 days of age. About 10 files a day at Studio volume, each around 0.5 MB. Direct callers keep the current behaviour (`minRecords` defaults to 1).
- **`compactArchives`** merges between 4 and 32 of the oldest files holding fewer than 100 records into one file, on each tick, stopping before the merged records pass 16 MiB so the output stays inside the reader's 32 MiB bound. A source too large to merge with its neighbour is left as it is and passed over. Each call reads at most its batch size of files, including damaged ones. For each source it verifies the digest, copies every row, then in one transaction records the new manifest, repoints `archive_id`, and removes the old manifest rows. Source files are deleted only after commit. A digest failure or missing file skips that source for the life of the process and leaves it untouched. The Studio's 18,662 files become about 600 in about 10 hours.

### 3. Every table is bounded

Three age lines:

- **Seven days: full detail leaves the hot tables.** Once an origin is archived, `purgeArchived` deletes its operation, children, materializations, attempts, outcome details, entries, payloads, notices, recovery schedule, diagnostics and verifications, at most 50 operations per tick. It reads a short window of operations by rowid, so it needs no scan, and a window with nothing to do moves on, so rows it must keep cannot hide the rows behind them. The origin row stays, with `record_json` empty, and the operation id moves to a small `telegram_origin_operation_index`. Three kinds of operation stay in place: one holding a reserved notice permit (those are made once per boot and are as old as the process), one that expired while held for `lease-not-held` and has not been reported once, and one with a receipt still waiting in the unrecorded-receipts file. The first and last kinds are also held back from archiving. `reconcileReceipt` is called only from that file, so an archive copy cannot go stale.
- **Seven days: metric events fold.** `foldMetricEvents` moves up to 2,000 events per tick (see pacing, below) into `telegram_origin_metric_rollups(metric,machine_id,count)` and deletes them. `getFederatedMetrics` adds rollups to the live scan, so totals do not change. Events carry no timestamp, so age comes from a marker: the `operation:prepared` event of the first origin at or past the line that still has one. With no origin past the line, every event is old enough. Rowids of that table are only compared inside one transaction, so a VACUUM renumbering them is harmless. The fold takes the machine from the origin row, which still exists then, and applies the same `legacy-unattributed` rule. Purging waits until the fold backlog is clear, because that rule looks at the operation row.

  Folding removes the keys that stop an event counting twice, so a repeated event older than the line would count again. Every `event()` writer needs a live operation, child or attempt, those are gone by then or at most days from it, and nothing writes to a terminal operation that old. The worst case is one counter off by one, on a counter that is not used for any decision. That is accepted.
- **365 days: the audit stub and its archive leave.** `expireAudit` deletes origin stubs older than `auditRetentionDays` (default 365), with their destinations and receipts, then any manifest and file that no stub in its own sequence range still points at, looking at 64 manifests per tick on a rotating position. Only archived rows are eligible. Audit expiry never touches an origin that still has operation rows. It records the cutoff, and `listOrigins` returns it as `historyExpiredBefore`, so a reader can see the history is not complete. `OriginPoolAudit` passes on the newest value across shards. An option, `auditRetentionDays`, changes the default; the operator asked for bounded retention on every table, and this is that explicit change to parent-spec item 11. A value that is not a whole number of at least 30 is ignored, so a mistyped setting cannot read as "delete everything". The setting is `messageOrigin.auditRetentionDays` in the Telegram messaging config.

This also changes parent-spec item 11's "retain 30 days hot". Searchable metadata and receipts stay hot for the whole retention period; only the full detail moves after seven days, because detail is what the size comes from and it stays readable through the archive.

Small tables: `telegram_origin_owners` is capped at the newest 2,000 rows, which is about 200 days of boots; detail is archived within 14 days, and archived records already carry `deliveryMachineId`. The manifest table holds one row per file, a few thousand a year, read through a partial index for compaction. The rest are already bounded: audit assertions (1,000 slots), browser recovery (256), notices and schedules (removed with their operation), and the health and cursor singletons.

Evidence-only origins (no operation row, 135 on the Studio) become archivable; they were previously kept forever. Once an origin is archived, new diagnostics and verifications for it are refused, because they would never be read back.

Expected steady state at Studio volume: about 10,000 operations of full detail plus a stub for every origin in the retention period, at about 700 bytes each with indexes. Live data measured after replay is 123 MB. It reaches about 350 MB after a full year, then stays there.

### 4. Reads keep working

`getOrigin` returns the archived audit record when the operation row has been purged, replacing only `sequence`. Listing by message id, topic or origin id works from the stubs, as today. `getOperation` resolves through `telegram_origin_operation_index`, so the outcome route, mesh receipts, PromiseBeacon and a same-id retry all still get the real result. The index is also the replay fence: `admit` refuses an indexed operation id with `operation-id-conflict`. It must key on operation id, because logical sends keep their operation id across retries but get a fresh origin id.

### 5. The file stops growing, and does not shrink by itself

Purged pages go on SQLite's free list and are reused, so the file stops growing and stays at its present size. Shrinking it needs `VACUUM`, and this spec deliberately does not run one. Measured on the replayed copy with the machine busy, VACUUM took 37 s to rewrite 123 MB. That is past the 30 s worker stall limit, and for that long every send is held and main-thread store connections block. An automatic shrink would be the very failure this spec removes. A half-empty file costs disk only, so it stays. Shrinking is a separate operator choice, queued as feedback.

### 6. The tick stays bounded

`maintainRetention` makes each step a separate awaited worker request, so at most one maintenance request is ever queued and an admit waits for at most one step. Order: `cleanupPayloads`, `foldMetricEvents`, `archive`, `compactArchives`, `purgeArchived` (only when the fold backlog is clear), `expireAudit`, which also trims owners. Steps after the first are skipped once 500 ms has passed. That check runs between steps and cannot interrupt one, so batch size is what keeps a step short.

**Pacing.** Fold, compaction and purge start small and adapt to what the disk just managed: a step over 250 ms halves its batch, one under 100 ms doubles it, within fixed limits (fold 200–2,000 events, compaction 4–32 files, purge 10–50 operations). A cold or busy store takes smaller steps. A failing step keeps today's behaviour: `retentionUnavailable` is set and delivery is unaffected.

**Only the server runs retention.** Server and lifeline both open this store, and a retention write in one makes the other's write wait. The lifeline passes `skipRetention`, which leaves it `cleanupPayloads` alone, so operations past their deadline still expire during a server outage. The store's busy timeout rises from 25 ms to 250 ms, so a send from the other process waits for a retention transaction instead of failing with `SQLITE_BUSY`, which would surface as the same `execution-admission-unavailable`.

## Decision points touched

| Decision point | Class | Note |
|---|---|---|
| Whether a re-admitted operation id is refused | invariant | Same answer as the existing replay conflict, extended past the operation row. Prevents a duplicate send only. |
| Whether a row may be archived, purged or expired | invariant | Fixed lifecycle states and age lines around a one-way data move. Retention never decides whether anything is sent. |
| Batch size for each retention step | invariant | Mechanical pacing from the last step's duration, within fixed limits. |

## Migration

No `PostUpdateMigrator` change is needed. New tables and indexes are created in the `OriginStoreBackend` constructor with `IF NOT EXISTS`, and the tick does the rest on every agent after update. All work is resumable. The archive cursor and manifests are durable; the purge position and the scan past a waiting row restart from the beginning after a restart, which costs a few extra rows. Rollback: reverting the code leaves purged data in archives. Old code still opens the store. Until a fix ships, its `getOrigin` shows a purged record without operation detail, and its federated counts drop by the folded amount. Nothing is lost.

## Multi-machine posture

Machine-local by design, like the store itself. Each machine's shard keeps its own retention. Pool reads stay federated, and `historyExpiredBefore` is carried across shards.

## Maturation plan

- **test-agent-live:** Replayed on scratch copies of the Studio store, from a cold cache, with audit and counter comparison before and after.
- **dev-agent-live:** Echo on the Studio after release: the origin retention status stays `unavailable: false`, archive files fall towards a few hundred, and the operation table falls to about 10,000 rows within a day or two.
- **fleet:** Ships on by default on the next release; every agent's store migrates itself on the retention tick.
- **graduation criterion:** On the Studio, no `execution-admission-unavailable` hold or `request-stalled` restart traces to a retention step for seven days after the backlog clears.
- **dark-window:** Zero. This fixes held operator replies, and the steps are bounded and resumable.

## Testing

- Unit: each step on both sides of its boundary (terminal versus active, young versus old, full batch versus quiet agent, corrupt archive skipped, totals unchanged after fold, `getOrigin` and `getOperation` after purge, replay refused under a fresh origin id, each kept kind of operation).
- Integration: the `/telegram/origins` routes still read a purged origin.
- E2E: the production boot path runs the retention tick and a purged origin is still retrievable.
- Replay: the compiled store on a scratch copy of the Studio database, from a cold page cache, with a store write probe running alongside, against an idle baseline of the same probe. It also compares sampled audit records and all counters before and after.
