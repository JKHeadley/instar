# Side-Effects Review — Telegram origin store retention

**Version / slug:** `telegram-origin-store-retention`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `independent agent, see below`

## Summary of the change

`OriginStoreBackend.archive` walks a durable cursor and writes batches. New steps: `compactArchives`, `purgeArchived`, `foldMetricEvents`, `expireAudit`. New tables `telegram_origin_retention`, `telegram_origin_metric_rollups`, `telegram_origin_operation_index`, and partial indexes for the admit count and cleanup. `getOrigin` and `getOperation` read through the archive once detail is purged. `TelegramOriginRuntime.maintainRetention` runs each step as one awaited worker request with adaptive batch sizes. The lifeline skips retention. The store busy timeout rises from 25 ms to 250 ms. `OriginPoolAudit` carries `historyExpiredBefore`. Files: `OriginStoreBackend.ts`, `OriginStore.ts`, `OriginStore.worker.ts`, `StoreTypes.ts`, `TelegramOriginRuntime.ts`, `TelegramOriginBoot.ts`, `OriginPoolAudit.ts`, `TelegramLifeline.ts`.

Tier 2: a fleet-wide state migration that runs on every agent after update. About 600 lines across 8 source files and 4 test files. Six Codex rounds, one independent internal round and a second-pass code review. Effort is proportionate to a one-way data move, though the review count is high for its size because each round found a real corner case.

## Decision-point inventory

- `admitInternal` — **modify**. Refuses an indexed operation id with `operation-id-conflict`. This extends an existing replay refusal past the life of the operation row, and it can only stop a duplicate.
- Retention eligibility (archive, purge, expire) — **add**. Deterministic rules about data lifecycle. They do not gate any message.

---

## 1. Over-block

A legitimate new send can only be refused if it reuses an operation id that was already delivered and purged. Logical sends use that id to mean "the same send", so the refusal is correct, and `getOperation` gives the caller the real receipt first. No other input is refused.

## 2. Under-block

- A store over the replay's size still pays cold-read costs on the first ticks after a boot. Steps were measured up to about 2 s on a machine at load 25–35, during the backlog only. Settled steps take under 100 ms.
- Sending paths unrelated to retention can still hit `execution-admission-unavailable` if the disk stalls. An idle probe under the same load peaked at 805 ms.
- A corrupt archive file stays uncompacted, and its records still fail to read, as they do today.
- The file does not shrink. That is a stated decision, not a gap: VACUUM took 37 s and would hold sends.

## 3. Level-of-abstraction fit

Retention belongs in the store backend, which owns these tables and the archive format. The runtime owns only cadence and pacing, as it did before. No higher layer needs to know.

## 4. Signal vs authority compliance

Required reference: `docs/signal-vs-authority.md`.

- [x] No — this change has no block/allow surface beyond the existing replay conflict, which it extends. It does not judge content or decide what may be sent.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Age lines and batch limits are deterministic data-lifecycle rules on enumerable states, chosen as safety guards around a one-way move.

## 5. Interactions

- **Shadowing:** none. `cleanupPayloads` still runs first; `purgeArchived` then removes rows it already emptied.
- **Lifeline:** it still runs `cleanupPayloads`, so due operations expire during a server outage, but none of the new steps.
- **Double-fire:** only the server runs the new steps, so server and lifeline cannot duplicate the work. The commit re-checks that sources still exist, so a race would abandon the merge safely.
- **Races:** a read in the lifeline can meet an archive file compacted a moment earlier and report `archive-unavailable`. It clears on the next read; the lifeline rarely reads audit. Accepted.
- **Recovery:** `reconcileUnrecordedReceipts` is the only caller of `reconcileReceipt`, and operations in that file are held back from archive and purge.
- **Outage notices:** operations with a reserved notice stay out of archive and purge until the permit is used or retired.
- **Held expiry:** an expired `lease-not-held` operation stays until its one-time report is made.

## 6. External surfaces

- Agents on the same machine: none.
- Other users of the install base: every agent's store migrates itself after update. Audit detail older than seven days now comes from archive files, so such reads are slower but equal.
- External systems: none.
- Audit API: new optional `historyExpiredBefore` field. Origin history older than 365 days disappears from about 10 months from now on, which is an operator-visible policy change, called out in the ELI16 and the release note.
- Persistent state: three new tables, four new indexes. New config key `messageOrigin.auditRetentionDays`, optional, with no migration needed.
- Timing: `store.admit` is no longer queued behind multi-second scans.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not operator-facing: no dashboard or user-visible action changes. The new setting has a safe default and rejects values under 30.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. The origin store is one shard per machine, and pool reads were already federated. Each machine retains its own shard on its own clock. `historyExpiredBefore` is carried through `OriginPoolAudit`, newest value across shards, so a pool read cannot imply complete history. No user-facing notices are added, and no state strands on topic transfer.

## 8. Rollback cost

Revert and ship a patch. No hand repair is needed. Purged detail stays in archives. Under the old code, purged records would show no operation detail in `getOrigin`, and federated counts would drop by the folded amount until the fix returned. Nothing is lost, and the new tables are ignored by old code.

## Conclusion

Review changed the design in six ways: an operation-id index replaced an origin-id fence, which did not cover logical retries; only the server runs retention, with a longer busy timeout; automatic VACUUM was removed after measuring it; batches became adaptive; archive scanning runs past a waiting row; reserved notices stay out of the archive. Clear to ship.

## Second-pass review (if required)

**Reviewer:** independent code-review agent
**Independent read of the artifact: concern, resolved**

Six code defects, none losing data. Fixed: compaction could stall behind a file too big to pair; the lifeline had lost the expiry sweep; an unreadable receipts file looked like an empty one; detail written after archiving was orphaned; owner trimming could remove reused `forwarded:` rows. Accepted: a `legacy-unattributed` origin imported out of order can drop a federated prepared count by a few, on legacy rows only.

## Evidence pointers

Replays used the compiled store on read-only copies of `pending-relay.echo.sqlite`, from a cold page cache. Audit sample 312 of 312 identical. Idle probe under load: p50 0.2 ms, max 805 ms, none over 1 s. Paced replay of the backlog: p50 0.3 ms, p99 196 ms, 3 of 2,636 over 1 s, at about 40 times the real tick rate. Before: 3 to 9.6 s every minute.

## Class-Closure Declaration (display-only mirror)

Self-triggered controller: `maintainRetention`, an existing bounded loop. Control edge: the 5 s boot tick with its 60 s brake, one tick at most. Steady-state bound: each step is capped per tick and does nothing once settled. Settling brake: unchanged 60 s minimum interval; batches can only shrink on slow steps. It acts only on rows, never on sends or processes.
