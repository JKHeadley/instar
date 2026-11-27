# Telegram history reads and log rotation no longer read the whole log at once

## What Changed

- **Cold topic history.** When the server was asked for the recent history of a Telegram topic missing from its in-memory cache, it read the entire message log in one synchronous step, split it and parsed it, before answering. The log can exceed 100 MB, so each such request blocked the server; an idle Laptop on 1.3.2084 spent most of its time there and its listener timed out. The read now goes backwards through the log in 1 MB pieces and stops once it has the entries it needs, the way scrolling back through older history already worked. The cache asks for up to 1,000 entries, so a topic with that many recent messages costs a few pieces. A quiet topic with fewer still reads and parses the whole log once per process, in pieces rather than in one block, and is then served from the cache.
- **Larger history cache.** The per-topic cache now holds 1,000 entries instead of 500, because several callers ask for 1,000 and went around the cache to the log every time.
- **Re-registered topics.** A topic whose session ends keeps its cached history for a while (the 64 most recent such topics), so a session that stops and starts again does not trigger a fresh log read.
- **Log rotation counting in both loggers.** The rotation fix from PR 3985 (count lines as they are written instead of rereading the log) now lives in one shared helper used by both the Telegram message log and the shared message logger, so neither rereads its log to decide whether to rotate.
- **Unreadable log.** A missing log still reads as empty history. Any other failure to open it (too many open files, no permission) is now reported instead of being cached as an empty history.

## What to Tell Your User

A machine with a large Telegram history stays responsive when it looks up quiet conversations or rotates its message log.

## Summary of New Capabilities

No new capability. Fixes: cold topic history reads the log in pieces and stops early when it can, the history cache matches what callers ask for, and both message logs rotate without rereading themselves.

## Evidence

Reproduction: the Laptop CPU profile of 2026-11-27 (1.3.2084, quota tracking off) shows scanLogForTopic and readFileSync at about 56 percent of self-time, with getTopicHistory a further 13.8 percent. Before: scanLogForTopic called readFileSync on the whole log for each cold topic. After: tests/unit/telegram-cold-topic-history.test.ts shows a request whose entries sit in the final 1 MB makes exactly one chunk read and never reads the whole file, that results across chunk boundaries, multi-byte text and channelId rows match the old behaviour, that a 1,000-entry request is served from the cache, that a non-missing open failure is thrown, and that unregister churn keeps a bounded set of tails. tests/unit/log-line-counter.test.ts covers the shared counter, and tests/unit/telegram-log-rotation-count.test.ts covers the 100,000 and 100,001 line boundary.
