---
title: "Telegram Origin Store Stall — a slow scan and a saturated host no longer hold replies"
slug: "telegram-origin-store-stall"
author: "echo"
parent-principle: "Structure beats Willpower"
parent-spec: "telegram-message-origin"
eli16-overview: "docs/specs/telegram-origin-store-stall.eli16.md"
approved: true
approved-by: "Echo under the standing rule that only constitution changes need Justin (2026-10-22, JKHeadley/instar); this is not a constitution change. Justin has not reviewed this spec."
lessons-engaged: [measure-the-fix-on-the-failing-workload, a-plausible-cause-is-not-a-measured-one, P19-no-unbounded-loops, P20-verify-the-state]
review-convergence: "2026-11-05T21:57:20.569Z"
review-iterations: 2
review-completed-at: "2026-11-05T21:57:20.569Z"
review-report: "docs/specs/reports/telegram-origin-store-stall-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 0
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Telegram Origin Store Stall

## Problem statement

On 2026-11-05 Justin's replies on Echo (Mac Studio, load 60-110) were held for over 20 minutes. Four separate faults were measured, and each one can hold a reply with working connectivity. A concurrent network fault at some moment is not excluded. All numbers below are from the Studio.

### Fault 1: one query held the store for 39 seconds

`listSessionDeliveryExceptions` was added on 2026-11-04 (PR #2741) and runs after every recovery tick, every 5 minutes. On a read-only backup of the live store (652 MB):

| Measure | Value |
|---|---|
| Exact query, first page | 39.4 s wall, 20.3 s CPU |
| Same query without the `outOfOrder` subquery | 30 ms |
| Exact query, all 1117 rows | 237 s |

Rows: 8707 operations, 65884 receipts (45936 in one topic), 2017 accepted operations since the query's cutoff. The plan drives the subquery from `telegram_origin_platform_receipts` on `transport=?`, which matches every receipt. `ORDER BY` uses a temp b-tree, so the subquery runs for every matching row before `LIMIT` applies: 2017 × 65884 probes. No index was missing and no table had grown unexpectedly. The cost grows with every reply sent.

The store worker handles one request at a time. While it runs, every send waits past its 2 s store budget and is held. After 30 s the stall watchdog kills the worker, which fails the query, so the next tick starts again. Log: 9 kills, all this query, about 5 minutes apart; the restart counter reached 4 of 6, and past 6 the store stays down until the 15-minute reopen.

### Fault 2: ETIMEDOUT with a working network

The failure is `ETIMEDOUT [ETIMEDOUT connect 149.154.166.110, EHOSTUNREACH connect 2001:67c:4e8:f004::9]`. Node gives each address 250 ms by default. `api.telegram.org` has one IPv4 and one IPv6 address, and this host has no IPv6 route. The real connect takes 160-190 ms, so there are 60-90 ms to spare, and the 250 ms is a JavaScript timer: if the event loop pauses across it, the timers phase runs before the completed connect is seen.

Measured in a separate process, pausing the event loop right after the connect starts, 15 attempts each:

| Pause | Failures at 250 ms | Failures at 5000 ms |
|---|---|---|
| 0, 100, 200 ms | 0 | not run |
| 240 ms | 9 | not run |
| 260, 300, 500 ms | 15 | 300, 500 ms: 0 |
| 1500 ms | not run | 0 of 8 |

The live server's event loop max was 415 ms. That would explain why a separate process with an idle loop connected 40 of 40 times, and why several sends fail at the same instant (one pause trips all their timers). It is a reproduction of the mechanism and the exact error, not an observation inside the live server, so attribution of each production timeout stays unverified.

### Fault 3: one failed config read refuses every send

`OriginConfigReader.read` has a 2 s budget and runs every 5 s. On timeout the reader bumps its revision and the boot code nulls its snapshot, so `authorize` refuses every send until the next good read. Log: 46 such episodes in 3.1 hours, 371 s in total, median 5.8 s, max 26 s. The config worker itself is not slow from outside: 25 reads in a separate process at load 58 took 51 ms median, 77 ms max. Which resource inside the server uses the 2 s is **not measured** (attaching to the live server was out of bounds), so this spec does not fix it by theory. It fixes what a timeout is allowed to mean.

### Fault 4: retries are not prompt

Three separate delays stack.

- A refused send gets a retry time of 30 s, but only the sentinel's 5-minute watchdog runs recovery.
- `reserveRecoveryAttempt` allows one start per 15 minutes per operation, and charges it before recovery runs. A first attempt that hits a brief fault spends the whole 15 minutes.
- Measured: 1d9b102f prepared 20:12:22, first recovery 20:16:53 (failed during a config-read episode logged 4 s earlier), reservation until 20:31:53, next tick 20:36:56. That is 24.5 minutes, with one transport attempt, which succeeded in under 1 s. ed01aa17 waited 22 minutes the same way.

An empty `next_attempt_at` is not the problem: eligibility is `next_attempt_at IS NULL OR <= now`, so such a row is picked up. Row 286207f6 was imported at its first tick and held at 20:17, as above. It and 2f75f88a ended `suppressed`: when the wait outlasted newer conversation, `allowQueuedRecovery` retired them. That policy is intended, and 75 ordinary operations ended this way in 24 hours. This means long waits lose replies outright, so the delay matters beyond lateness.

## Proposed design

1. **Bounded scan.** A new index `telegram_origin_operation_prepared(kind,prepared_at,operation_id)` lets the page be read in cursor order, which avoids sorting the whole candidate set. `outOfOrder` moves to a per-row lookup, run only for accepted rows on the returned page. That lookup starts from this reply's receipts and walks only operations written between this reply's `prepared_at` and its acceptance plus a 5-minute clock tolerance. CROSS JOIN and unary plus pin the plan to `child_id`, since the planner otherwise chooses a topic-wide or store-wide receipt index. The proof for the window: message ids rise with time in a chat, so a reply that landed first was written before this one landed, and this one landed before its acceptance was recorded. Equivalence with the old query depends on clock disagreement between machines staying within the 5-minute tolerance. Greater skew can suppress an out-of-order notice, and never affects delivery.
2. **Connect attempt window.** Bot API requests go through their own undici dispatcher with a 5000 ms per-address window. Other connections in the process keep Node's default, so a host elsewhere that drops its first address keeps its fast fallback. undici's 10 s connect timeout still bounds the connect.
3. **Config read meaning.** Budget raised from 2 s to 10 s. Nothing waits on a read: sends use the last snapshot under its existing 30 s bound. A read that only ran out of time neither bumps the revision nor drops the snapshot, and the snapshot still ages out at 30 s. Every other failure (unparseable, too large, wrong shape, token changed, decrypt failure) revokes at once, as today. A change on disk still revokes at once through the source poller, which does not depend on the read succeeding (it does use the same libuv thread pool, so if that pool is what is saturated, revocation can lag until the 30 s age-out). `observedAt` now counts from before the bytes are read, so the 30 s bound is a true bound on the age of the data. A worker that answers after its deadline now reports a timeout rather than a secret-store failure.
4. **Recovery pacing.** When the origin outbox owns recovery the sentinel ticks every 30 s. The reservation interval becomes 30 s, 1 m, 2 m, 5 m, then 15 m. The legacy lane keeps 5 minutes.
5. **Notice rate unchanged.** The exception scan raises reader-visible notices, so it keeps its 5-minute pace however often recovery runs.
6. **A first send is left alone.** Recovery skips an operation whose first pass is still running in this process. Its policy review can take seconds, and a tick landing inside that window could otherwise judge the reply overtaken and retire it before it was tried. This existed before, and the shorter tick would have made it about ten times likelier.

## Decision points touched

- `authorize` via `healthy()` — invariant — modified: a timed-out read no longer revokes a snapshot inside its 30 s bound. This is send authority, narrowly widened in one case. Bound and all revocation paths unchanged.
- `reserveRecoveryAttempt` pacing — invariant — modified: interval only. The eligibility SQL is unchanged.
- `allowQueuedRecovery`, the claim fence, `markDispatched`, outcome recording, `provedUnsentCode` — invariant — pass-through, untouched.

## Double-send safety

This change adds no send path. Every retry still reaches the network only through `reserveRecoveryAttempt` and `claim`. An operation with an `outcome-unknown` child is ineligible at both steps, because a non-`queued`, non-`accepted` child excludes it. A test walks the ladder and then proves an uncertain operation stays ineligible at each later time. Transport budget (`max_attempts`) is spent only by claims, not by reservations. The attempt window lengthens how long a connect may take before it is judged failed. A connect that never opened is still the only thing proved unsent.

## Replacement measured on the failing workload

Through the real worker, on a fresh copy of the same backup, at load 20-50:

| Measure | Value |
|---|---|
| Full scan | 12 pages, 1117 rows, 1.04 s total |
| First page, cold cache | 419 ms and 557 ms on two runs |
| Later pages | 57-75 ms |
| Past the last row (examines every candidate, returns none) | 1 ms |
| Results compared with the old query | 1117 rows, 0 differences, 40 out-of-order |
| A store write every 25 ms during the full scan | median 16 ms, max 528 ms (budget 2 s) |
| Out-of-order lookups alone, worst case: 100 rows each delayed the full 6 hours, in the densest stretch (479 operations in the window) | 36 ms |

These timings validate the fix at this store's size. They are not a general bound. The limit bounds returned rows rather than examined rows. Examined rows follow the store's size: 7 days of retention bounds elapsed history, and traffic sets how many operations that holds (8707 today). A single step still cannot be interrupted, as the retention spec accepted, and a machine much slower than this one could take longer on its one cold first page.

## Costs of running more often

On the copy, one recovery tick's store calls take: health 20 ms, legacy 1 ms, reap 1 ms, undiagnosed 142 ms (at load about 110), take 2 ms. Ten times as often is acceptable and each one holds the worker for far less than the 2 s budget. Recovery starts per operation in 6 hours go from 24 to 28. The reviews these starts may run are the reason the brake exists; the cost rises by 4 per operation at most, and only for operations that keep failing.

## Accepted consequences

- **Transport budget is spent sooner under sustained failure.** Reservations spend no budget, but faster starts mean faster claims. Under a failure that keeps being proven unsent, all 9 attempts are used by about 3h53 instead of 4h45, inside the 6 hour deadline. An outage ending between those times now ends the reply as `known-failed`. Accepted: a reply that old has almost always been overtaken, and the honest notice still goes out.
- **The notice observer keeps its own 2 s budget.** `OriginNoticePolicyObserver` drops alert permission when its read takes over 2 s. Alerts can be withheld while sends continue. It fails closed and is not a reply path.
- **`/health` during a timeout.** The reader reports `healthy` with reason `source-read-unavailable` until the snapshot goes stale, which is accurate: the last read failed, and the state is still inside its bound.
- **Boot's first config read can take 10 s rather than 2 s** on a saturated host.

## Rollback

A plain revert. The added index is additive and unused by older code. Recovery schedule rows hold plain timestamps that older code reads correctly. No migration or config change.

What stays unproven until live is listed in the side-effects review.

## Maturation plan

- **test-agent-live:** Replayed on scratch copies of the Studio store with a store write probe alongside, and the connect fix through the real egress door with a tokenless request.
- **dev-agent-live:** Echo on the Studio after release: no `request-stalled` restart naming this query, far fewer `config snapshot unavailable` and `connect failed before request` lines, and held replies accepted within about a minute.
- **fleet:** Ships on by default on the next release. The added index builds itself when the store opens.
- **graduation criterion:** On the Studio for seven days, no reply waits over two minutes from a local fault, and the query never appears in a worker failure.
- **dark-window:** Zero. This fixes held operator replies, adds no send path, and a revert restores the old behaviour.
- **ladder:** not applicable: no flag, a bug fix to existing delivery with no new capability to mature.

## Open questions

*(none)*
