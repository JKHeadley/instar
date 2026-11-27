# Side-Effects Review — Quota fallback no longer blocks the event loop; OAuth 429 retry-after honored

**Version / slug:** `quota-jsonl-fallback-nonblocking`
**Date:** `2026-09-22`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Incident 2026-09-22: the laptop's server froze for 30-80s every 1.5-4 min, and peers reported it as down. The Anthropic OAuth usage endpoint was answering 429 (`retry-after` 750-3570s). On every poll that followed, `QuotaCollector.collect()` fell through to `collectFromJsonl()`. That function `readFileSync` + `JSON.parse`d every line of every `~/.claude/projects/*/*.jsonl` modified in 7 days (~34k files) on the main thread. A CDP CPU profile attributed about 35% of all samples to `JsonlParser.parseFile` under `collectFromJsonl`. `RetryHelper` also re-sent each 429'd request up to 3× at 30s intervals inside a single poll.

Changes:
- `src/monitoring/QuotaCollector.ts`:
  - `RetryHelper.withRetry` throws immediately when a `retry-after` hint exceeds `maxDelayMs`.
  - `collect()` opens the OAuth backoff for the full `retry-after` window on the first 429 that carries a positive hint, capped at 6h. The existing 3-consecutive-429 breaker is kept for hint-less or `retry-after: 0` 429s.
  - The fallback is now async. It reads an injected `UsageTotalsSource` (`setUsageTotalsSource`, `wireQuotaCollectorToTokenLedger`), or else a new incremental index. It returns no estimate while that index is still catching up.
- `src/monitoring/JsonlUsageIndex.ts` (new) is the incremental index:
  - Remembers a per-file byte offset and inode, and keeps hourly buckets.
  - Uses async I/O and yields between files and every 2000 lines.
  - Caps reads at 256 MiB per pass and only parses lines containing `"usage"`.
  - Resets everything if a file shrinks or is replaced.
- `src/server/AgentServer.ts`: after the TokenLedger is built, it wires `options.quotaManager.collector` to `ledger.summary({sinceMs}).totalTokens`.
- Tests:
  - New unit, integration and e2e files.
  - An existing e2e test that silently scanned the real `~/.claude/projects` now uses an injected source.

## Decision-point inventory

- `QuotaCollector` OAuth backoff (`oauthBackoffUntil`) — **modify** — also opens on a single 429 with a positive retry-after. Previously it opened only after 3 consecutive 429s.
- `RetryHelper.withRetry` in-poll retry — **modify** — stops retrying when the requested wait is longer than the retry helper will sleep.
- Quota estimate production (the `jsonl-fallback` source) — **modify** — same output shape and `estimated` confidence label, but the reading is **recalibrated**. Claude Code repeats a request's usage on each content-block line. The old parser counted every such line; in a live transcript that was 224 usage lines for 104 unique requestIds, about 2.2× high. Both new paths (the TokenLedger, and the built-in index, which now dedupes by `requestId`) count each request once. For the same activity the estimated percent is therefore roughly half the old figure, against the unchanged 7.5B-token budget constant. The deduped total is the correct token count. The budget constant is a rough guess that was never calibrated, and this change does not re-tune it (see §2). Tracker thresholds, spawn gating, and `jsonlCanTriggerMigration` (default false) are unchanged.

---

## 1. Over-block

No block/allow surface. The closest analogue: while the backoff is open, no authoritative OAuth reading is requested. Previously the collector re-asked 4× per poll and got 429 each time. The only lost reading would come from an Anthropic endpoint that recovers before its own `retry-after` expires. That's rare, and the 6h cap bounds a nonsense hint.

## 2. Under-block

No block/allow surface. Residual risks:
- **Recalibration toward a lower reading.** As described in the inventory, the estimated percent is about half the old double-counted figure. That is the more permissive direction for anything that reads an estimated percent. It only matters while OAuth is unavailable, it is labelled `estimated`, and estimated readings do not trigger migration by default. The authoritative OAuth reading takes over again when the backoff ends. Re-tuning the 7.5B budget constant needs real calibration data (OAuth percent vs. deduped 7-day tokens), which this change does not have.
- **Ledger lag.** The ledger path inherits the ledger's lag: about 1 min, or 5 min when idle. Worse, a brand-new ledger backfills 500 files per tick. On about 34k files that is on the order of an hour of low readings. An existing agent's ledger persists across restarts and is already caught up. Unlike the built-in index, the ledger path has no "caught up" gate. Adding one needs a completion signal from TokenLedgerPoller, which does not exist today.
- **Missed tokens.** The ledger skips lines without a `requestId`/`sessionId`/`timestamp`, which the old parser counted. These are malformed or legacy lines, so the effect is small.

## 3. Level-of-abstraction fit

This moves the estimate onto the TokenLedger, the existing incremental, SQLite-backed index over exactly these files. The old code was a second, blocking re-implementation of the same scan. The built-in index exists only for installs where the ledger failed to initialize, and for hermetic tests. It keeps the collector self-contained rather than making the fallback depend on a subsystem that may be absent.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The collector produces a quota reading, which is a signal. Every authority that consumes it (tracker thresholds, spawn gating, migration) is unchanged.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Honoring a server-issued `retry-after` is protocol conformance, not judgment. The 6h cap is a sanity bound on an external value.

## 5. Interactions

- **Shadowing:** the retry-after backoff is now evaluated before the 3-consecutive breaker. The breaker still trips for hint-less 429s. A successful OAuth response still clears both.
- **Double-fire:** the ledger path makes the fallback read-only against the ledger, so TokenLedgerPoller and QuotaCollector no longer both scan the same files. Concurrent `collect()` calls without a ledger share one in-flight index pass.
- **Races:** `setUsageTotalsSource` is called during AgentServer construction. `QuotaManager.start()` in server.ts runs before `new AgentServer(...)`, so polls before the wiring use the built-in index. That index is async and bounded, so an early poll cannot block. A ledger closed at shutdown throws; that is caught and yields "usage ledger unavailable".
- **Feedback loops:** the removed loop is the incident itself. Each poll re-fired a blocking scan against a 429 that never cleared. The 429 retries also plausibly extended the rate limit. Both are closed.
- **DegradationReporter volume:** a retry-after 429 now reports once each time the backoff opens (at most once per window). Previously it reported once per breaker trip. The "index catching up" condition reports once per collector lifetime.

## 6. External surfaces

- **Anthropic OAuth endpoint:** strictly fewer requests, since the retry-after is honored and in-poll retries stop.
- **Other agents on the same machine:** less disk/CPU pressure, as there is no repeated full transcript read.
- **Persistent state:** none added. The index is in memory. The ledger is only read.
- **`getBudgetStatus().oauthCircuitBreaker`:** the shape is unchanged. `open`/`backoffUntil` now also reflect retry-after windows.
- **Public API (`src/index.ts` exports `RetryHelper`):** `RetryHelper.withRetry` now throws immediately when a `retry-after` hint exceeds the caller's `maxDelayMs`. Before, it slept `maxDelayMs` and retried inside the server's requested window. The only in-repo caller is `QuotaCollector.oauthGet`. An external caller that relied on the early retries would now see the error sooner.
- **Estimated-usage number:** it drops by about half for the same activity (dedupe, §2). Any dashboard or alert showing the `claude-jsonl` estimate will show the lower, correct token count.
- **Operator surface:** no operator-facing actions.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design. Each machine polls its own Claude account's OAuth quota and reads its own local transcripts and ledger. The backoff state is per-process and belongs to the local credential's rate limit. It emits no user-facing notices and holds no durable state. No URLs.

## 8. Rollback cost

Pure code change: revert and ship a patch. No persistent state, config, or migration. During a rollback window, the old behaviour (and the freeze) returns only on machines whose OAuth endpoint is 429'ing.

## Conclusion

The fix removes the freeze in two ways. It stops re-polling inside the server-requested wait, and it computes the estimate without reading transcripts on the request path. Review-driven changes:
- The built-in index withholds partial estimates. An undercount would read as spare quota, which is the unsafe direction.
- An e2e test that was silently scanning the developer's real home directory was made hermetic.

The class-level self-action registry entry is tracked (see below). Clear to ship.

## Second-pass review

**Reviewer:** independent reviewer subagent
**Independent read of the artifact:** concur (round 2). Round 1 raised four concerns, listed below; the reviewer re-checked each resolution in the worktree and concurred.

- **Estimate silently recalibrated (~2× from dedupe) and the two paths disagreed.** Resolved: the built-in index now dedupes by `requestId` (new unit test), so both paths agree. The recalibration is stated in the inventory, §2 and §6.
- **The partial-estimate guard doesn't cover the ledger path; a fresh-ledger backfill is about an hour, not minutes.** Resolved in wording (§2, ELI16). A gate needs a poller completion signal that doesn't exist today. It only affects brand-new ledgers.
- **Double count at the window edge** when a file's cursor is dropped while its boundary-hour buckets remain. Resolved: files are tracked one hour past the window, so a cursor outlives its buckets. New unit test, verified failing without the fix.
- **`RetryHelper` public-API behaviour change.** Resolved: documented in §6.

The reviewer independently confirmed these as clean:
- UTF-8 chunk splitting.
- Loop termination and progress.
- No long sync work on the collect path. The ledger `summary()` took about 0.04s CPU on the real 598 MB DB.
- Retry-after/breaker semantics, the production wiring, and the ordering claim.

## Evidence pointers

- `tests/e2e/quota-jsonl-fallback-nonblocking.test.ts`: longest timer gap under 75 ms during a ~72 MB fallback, 1 OAuth request per window, and the next poll opens only the appended file. **Verified failing against the pre-change collector:** only 2 timer ticks got through during the scan.
- `tests/integration/quota-collector-token-ledger-wiring.test.ts`: real AgentServer. The estimate comes from the ledger (30%), not a 7B-token decoy transcript, and no transcript is opened. **Verified failing with the wiring line removed:** 93.3% from the decoy.
- `tests/unit/jsonl-usage-index.test.ts` (9) and `tests/unit/quota-collector.test.ts` (+10).
- Live incident diagnosis: `sample` plus a CDP profile of pid 67087; hotpatch verification showed 240/240 fast health checks after the restart.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action`. The quota poll re-fired a costly fallback, plus up to 3 in-poll retries, against a 429 that never cleared, with no dwell. The fallback's own cost froze the event loop. This is the same shape as the 2026-06-05 live-tail spiral.
- **`closure`:** `gap`, tracked as **ACT-1292**: register the QuotaCollector OAuth poll in `src/testing/selfActionRegistry.ts` as an eternal sentinel with rate floor = max(poll interval, retry-after), after the self-action-backpressure governor work (CMT-1911) lands.
- **Instance guard in this change:**
  - `tests/e2e/quota-jsonl-fallback-nonblocking.test.ts`: at most one OAuth request per retry-after window across polls, and fallback cost proportional to appended bytes.
  - `tests/unit/quota-collector.test.ts`: the retry-after cases.
