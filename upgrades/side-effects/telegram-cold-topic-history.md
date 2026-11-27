# Telegram cold topic history side effects

## Decision and authority

No authority changes. Six internal changes to how the Telegram adapter and the shared message logger read their logs:

1. `TelegramAdapter.scanLogForTopic`, the fallback for a topic not in the tail cache, keeps its contract: up to `limit` entries for the topic, oldest first, accepting both `topicId` and `channelId` rows, skipping malformed lines. It now reads backwards in 1 MB chunks with a byte carry between chunks (the getTopicHistoryBefore pattern) and stops once `limit` entries are found. A short read (the log shrank under the scan) stops the scan with the entries already found.
2. A missing log (ENOENT, including one removed between the exists check and the open) still returns an empty history. Any other open failure (EMFILE, EACCES) is now thrown, as the old readFileSync did, so the caller does not cache an empty history for a topic that has one.
3. `TAIL_CACHE_LIMIT` rises from 500 to 1,000. The window-lifecycle routes and the AgentServer notifier checks ask for 1,000 entries and went to the log on every call at 500.
4. `unregisterTopic` keeps the cached tails of the 64 most recently unregistered topics (`UNREGISTERED_TAIL_LIMIT`) instead of dropping each one at once. Beyond that bound the oldest is reclaimed. `rememberLoggedEntry` keeps retained tails current on both write paths, so a retained tail is never stale for writes from this process.
5. New `src/messaging/shared/LogLineCounter.ts` holds the incremental line count from PR 3985. Both `TelegramAdapter.maybeRotateLog` and `MessageLogger.maybeRotate` use it, so neither rereads its whole log to count lines. It recounts after a rename (new inode) or a shrink. An overcount only triggers the exact full read, which then adopts the true count.
6. The MessageLogger rotation catch is annotated as an intended fallback; no behaviour change there.

## Data and resource effects

No data is written and no format changes. For a cold topic with at least 1,000 recent entries, event-loop time and memory drop from the whole log to the chunks needed. The tail-cache seed asks for TAIL_CACHE_LIMIT, so a quiet topic with fewer than 1,000 entries still reads and parses the whole log once per process, in 1 MB pieces rather than one block, and is then cached. Each cached tail can now hold up to 1,000 entries (twice the old memory per topic), and up to 64 unregistered topics keep theirs. Cold topics that were never registered are still cached without a bound, as before this change. Not changed: the one-time batch seed of live topics (seedTailCacheFromLog) still reads the whole log once per process, and PR 3992's latest-entry index is untouched.

## Rollback and verification

Rollback: revert this change's commit, which restores the previous `scanLogForTopic`, `TAIL_CACHE_LIMIT = 500`, `unregisterTopic` dropping the tail at once, and the counting code inside `TelegramAdapter.maybeRotateLog` and `MessageLogger.maybeRotate`; it deletes `src/messaging/shared/LogLineCounter.ts` and the new tests. Files: src/messaging/TelegramAdapter.ts, src/messaging/shared/LogLineCounter.ts, src/messaging/shared/MessageLogger.ts, and the tests below.

Verification: tests/unit/telegram-cold-topic-history.test.ts (results across chunk boundaries with multi-byte text and channelId rows, early stop after one chunk with no whole-file read, an unknown topic, a missing log, a 1,000-entry request served from the cache, EMFILE rethrown, unregister churn bounded at 64); tests/unit/log-line-counter.test.ts (counts after appends, rotation, shrink and adopt, and MessageLogger at 100 and 101 lines); tests/unit/telegram-log-rotation-count.test.ts (100,000 lines read in full and not rotated; 100,001 rotates to 75,000); tests/unit/TelegramAdapter-topicTailCache.test.ts (now caps at 1,000) and tests/unit/telegram-topic-history-before.test.ts cover the surrounding cache and the reader this copies.

## Second-pass review

**Reviewer:** independent sub-agent (general-purpose), 2026-11-27 14:29 PT, read only (no tests run on the M5 under the disk hold). Verdict: CONCUR WITH CHANGES.

It traced every new test to pass and found the chunk carry, UTF-8 handling, final line, order, file handle closing, ENOENT and rethrow, LogLineCounter rotation handling and the retained-tail updates correct, with no effect on PR 3992's latest-entry index. No ratchet flags the change (no-silent-fallbacks compares against its baseline, and every new catch has a comment body or an annotation). Applied from its findings: the release note and this file no longer claim a quiet topic costs one chunk; this file now covers all six changes, the memory effect and a real rollback; the stale unregister comment is rewritten; the tail-cache cap test asks for 1,000; the stray decision record is kept, not deleted (it is PR 3985's own blocked gate run saved under the wrong slug, and real audit history); the scan stops on a short read. Not applied, noted for later: skipping JSON.parse on lines that do not mention the topic id, which would make a quiet topic's full pass mostly a byte search.

## 6b. Operator-surface quality

No visible surface changes. The machine stays responsive.

## Framework generality

Telegram adapter and shared logger internals only. Nothing depends on an agent framework or model provider.
