---
title: "Conversation list and first chat read scan the Telegram log off the main thread (Option C of the freeze fix)"
slug: "conversation-list-offthread-scan"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "conversation-list-offthread-scan.eli16.md"
status: "approved"
approved: true
approved-by: "The Chief of Staff, relayed by the outage-repair coordinator (topic 145840, 2026-11-21): Option C chosen over the in-memory log view (pull request 3602) after the four-way real-log measurement; replaces piece 1."
feedback: "fb-52447f16-7d3"
replaces: "pull request 3602 (docs/specs/conversation-list-log-view.md there), which stays a draft"
---

# Conversation list and first chat read scan the Telegram log off the main thread

## Problem

On 2026-11-21 the Echo Studio server froze for 20-30 s at a time. A CPU profile taken during a freeze
put the largest self-time in `TelegramAdapter.scanLogForTopic` ← `getTopicHistory` ← the
conversation-list producer (`AgentServer.conversationFlatDeps.telegramTopics`) ← `GET
/mobile/conversations`. The list asked for each topic's newest message, and unread counting asked
for up to 500 rows per topic with unread messages. For each topic whose tail was not cached yet,
`scanLogForTopic` read and parsed the whole log file synchronously (31 MB on Echo). On a copy of
Echo's real log the old code's cold list took 19.6 s, and the server answered nothing else for
19.5 s of it.

## What already exists (unchanged)

- `topicTailCache`: the newest 500 parsed rows per topic, filled on a topic's first read
  (`seedTailCacheFromLog` for live topics, `scanLogForTopic` for any other topic) and kept current
  by `rememberLoggedEntry` after every successful append.
- `getTopicHistory`, `scanLogForTopic`, `seedTailCacheFromLog`, `getTopicHistoryBefore`, the
  unread counter (`ConversationUnreadService`), the list producer, and both log trims
  (`maybeRotateLog` and `MessageLogger.maybeRotate`). None of them changes in this spec.

## The change

One new adapter method, `warmTopicTails(topicIds)`, fills the EXISTING tail cache for every given
topic that is not cached yet. There is no second copy of the log: the rows go into the same cache
the old code fills, and every reader keeps reading through the unchanged `getTopicHistory`.

1. **Same rows as the old read.** One pass over the file applies `scanLogForTopic`'s own parse to
   every wanted topic: split on `\n`, skip empty lines, `JSON.parse`, match `topicId ?? channelId`
   as a number, skip malformed lines, keep the newest 500 rows per topic in file order. A final
   line without a newline is parsed, as the old read parses it. A topic with no rows caches `[]`,
   as `scanLogForTopic` does. Multi-byte characters split across block edges are joined by a
   `StringDecoder`, so the text equals a whole-file UTF-8 decode.
2. **Off the main thread.** The file is read with `fs.promises` in awaited 64 KiB blocks; each
   block's lines are parsed in their own turn. No turn does more than one block.
3. **Saved only after an end-of-same-file check.** At the end of the read:
   - `fs.statSync(path, {bigint})` must show the same `dev` and `ino` as the opened handle, and a
     size equal to the bytes parsed (larger: more was appended, so the rest is read first;
     smaller, or another file: give up).
   - The parsed range is read again and its SHA-256 compared with the hash of the bytes that were
     parsed. A rewrite of bytes already read, even at the same length, makes them differ.
   - A second `statSync` must still show the same identity, size, `mtimeNs` and `ctimeNs` as the
     first. Any write during the re-read moves the change time; an append alone starts another
     round (read the new bytes, re-check), at most 3 rounds.
   - Only then, in that same synchronous turn, are the rows saved, and only for topics still not
     cached (an append to a cached topic, or a synchronous read during the scan, may have filled
     one; that copy is kept). Local appends run on the main thread, so none can fall between the
     check and the save.
4. **Shared scan.** A request arriving while a scan runs waits for the same promise. A topic that
   the running scan was not asked for gets at most one more scan of its own.
5. **Fallback.** On a read error, an open error, a replaced or shrunk file, a hash mismatch, a
   change during the check, or a file still changing after 3 rounds, nothing is saved, the error is
   logged, and the unchanged synchronous code reads the file exactly as before.

### Where it runs

- `GET /mobile/conversations` awaits `warmTopicTails(all mapped topics)` after its read gate and
  before the unchanged list code runs.
- `GET /telegram/topics/:topicId/messages` without `before` (a chat opened before any list, for
  example a notification tapped right after a restart) awaits `warmTopicTails([topicId])` before
  the unchanged `getTopicHistory`. The pool form of a chat read reaches the same route on the
  machine that holds the topic, so it waits there too.

### Off switch

`telegramHistoryScan.offMainThread: false`, read live on every request through the server's
LiveConfig reader (the config object when no LiveConfig is wired). Off, neither route calls
`warmTopicTails`, so both use the old synchronous read; no restart or release is needed. Absent
means on. An adapter without `warmTopicTails` (a test stand-in, an older build) keeps the old read.

## Limits (stated, not hidden)

- **Requests wait for the scan.** A cold list (or a cold chat read) waits for the one shared scan,
  measured at about 0.2-0.4 s on Echo's 31 MB log; later requests do not wait. A list request from
  another of this agent's machines waits for the scan on the machine it asks. If that machine's
  first cold scan took longer than the asking machine's 5 s budget (`POOL_TIMEOUT_MS`), the asker
  records that machine as `pool.failed` with reason `deadline` and its conversations are missing
  from that one merged page, the same as with the old code's freeze. The scan is not cancelled; it
  finishes and saves, so the next list includes that machine. Reaching 5 s would take a log about
  25 times larger, or a badly overloaded machine; the trim keeps the log near 100,000 lines.
- **App timeouts.** Every app build since v0.2.0 build 4 gives a list read 12 s
  (`timeoutIntervalForRequest = 12`) and then reports the agent unreachable or tries its next
  route; that retry joins the scan still running. The old code's 19.6 s cold list crossed that
  limit; this scan does not.
- **A hung disk hangs the wait.** The route awaits the scan with no deadline of its own; a read
  that never returns leaves the request waiting until the app's own timeout. A disk in that state
  hangs the synchronous read too.
- **Other readers keep the old read.** Scroll-back pages (`getTopicHistoryBefore`), the
  respawn-history mesh read, and any other caller that reaches an uncached topic without going
  through these two routes still read synchronously, exactly as today. The scroll-back read was
  already a single pass per page.
- **Change time is the write detector during the re-read.** It relies on the file system's change
  time moving on every write (nanosecond resolution on APFS and ext4). A file system with
  one-second times could miss a same-length rewrite made during the re-read itself, in the same
  second as the first check. The hash still catches every rewrite made during the main read.

## Acceptance

- The list and a cold chat read answer exactly what the old synchronous read answers (unit replay
  against a fresh adapter; integration on/off comparison; real-log comparison with zero
  differences).
- Injected failures save nothing: a read error mid-scan, a file replaced mid-scan (including a
  same-size file renamed in), a same-length rewrite of bytes already read, a same-length rewrite
  during the re-read, and a log that changes through every round.
- Concurrent requests share one scan.
- The switch set to false returns both routes to the old read, live.
- A production-constructed server over a ~25 MB log answers a cold list and a cold chat read with
  the longest event-loop stall under one second, measured in-test; the same test fails with the
  switch off.

## Rollback

Set `telegramHistoryScan.offMainThread: false` (live), or revert the pull request. No state is
written; the cache is in memory and rebuilt on demand.
