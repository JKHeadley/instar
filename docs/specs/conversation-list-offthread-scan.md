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
   block's lines are parsed in their own turn. No turn does more than one block. Each round reads
   only up to the size seen when it starts, so a writer that keeps appending cannot keep a round
   going.
3. **Saved only after an end-of-same-file check.** At the end of each round's read:
   - `fs.statSync(path, {bigint})` must show the same `dev` and `ino` as the first opened handle
     (every round's handle is checked too), and a size equal to the bytes parsed (larger: more was
     appended, so the next round reads the rest; smaller, or another file: give up).
   - On a file system whose change times are whole milliseconds or coarser (the nanosecond part is
     zero), the re-read starts only once the last change is 2.5 s old, so any write during the
     re-read moves the change time. APFS and ext4 keep nanoseconds, so this wait does not occur
     there.
   - The parsed range is read again and its SHA-256 compared with the hash of the bytes that were
     parsed. A rewrite of bytes already read, even at the same length, makes them differ.
   - The handle is closed, then a second `statSync` must still show the same identity, size,
     `mtimeNs` and `ctimeNs` as the first. Any write during the re-read moves the change time; an
     append alone starts another round, at most 3 rounds in all.
   - Only then, in that same synchronous turn, are the rows saved, and the waiting request reads
     the cache in that same turn (only promise continuations run between), so no append, trim or
     other I/O callback falls between the check, the save and the read. Rows are saved only for
     topics still not cached (a synchronous read during the scan may have filled one; that copy is
     kept) and not evicted by `unregisterTopic` since the scan started (a per-topic eviction count).
4. **Consistent with the first-miss seed.** The old code's first cache miss seeds every live
   topic (`topicToSession`) in one pass and sets `tailCacheSeeded`; the seed appends every row on
   disk to any tail already cached, so it must never run after this scan saved tails. While
   `tailCacheSeeded` is false the scan also fills every live topic and, on saving, sets the flag:
   from then on the cache holds exactly what the old seed would have produced.
5. **Shared scan.** A request whose topics are all cached returns at once and never waits on a
   scan. A request arriving while a scan runs waits for it (item 8).
6. **A replaced or trimmed file.** The trim (`maybeRotateLog`, `MessageLogger.maybeRotate`) renames
   a new file into place. If a scan sees the file replaced or trimmed for any reason, at any point,
   it keeps nothing from that scan and the request's old read runs on the file as it is. No partial
   result is ever saved.
7. **An unfinished last line.** Every request, including one joining a running scan, checks the
   log's last byte itself before any wait (on the descriptor it opened). If it is not a newline (a
   writer mid-line, or a crash), the request does not wait and its old read runs in its own turn,
   exactly when the old code would have read. A scan that ends on an unfinished line saves nothing.
8. **One wait budget per request, one scan at a time.** A request's total wait is capped at 3.5 s
   counted from its arrival (inside the 5 s budget another of this agent's machines gives a list
   read). It waits for at most one scan, never starts a second one behind a running one, and never
   joins a scan that has used up its own 3.5 s limit (it runs the old read at once); a request that
   joins a running scan stops waiting at whichever comes first, the scan's limit or its own. Topics
   the running scan does not cover fall to the old read. The scan is held until it really ends, so
   a stuck scan is never joined by a second, and it is the only record kept: each waiter is removed,
   with its timer cleared, when it stops waiting. A scan checks its expiry before each read and in
   the turn that would save, so a late scan never saves.
9. **Fallback.** On a read error, an open error, a replaced or shrunk file, a hash mismatch, a
   change during the check, or a file still changing after 3 rounds, nothing is saved, the error is
   logged, and the unchanged synchronous code reads the file exactly as before.

### Where it runs

- `GET /mobile/conversations` awaits `warmTopicTails(all mapped topics)` after its read gate and
  before the unchanged list code runs.
- `GET /telegram/topics/:topicId/messages` without `before` (a chat opened before any list, for
  example a notification tapped right after a restart) awaits `warmTopicTails([topicId])` before
  the unchanged `getTopicHistory`, and then checks the phone's access to that topic again, because
  the old code checked it in the same turn as the read and a grant may be removed during the wait.
  The list computes its per-person visibility after the wait, as before. A phone's first unread
  baseline is attempted exactly once per list request, at admission, before any wait. Rule: when in
  doubt a message counts as unread (a reply shown unread when it was read is harmless; one hidden as
  read is not). An attempt at admission only ever makes later replies unread, and a single attempt
  means no later attempt can set a baseline after a reply saved during the wait.

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
- **Change time is the write detector during the re-read.** Every write moves a file's change
  time; on a file system with coarse times the settle wait above makes sure a write during the
  re-read lands on a later tick (up to 2 s granularity). The hash catches every rewrite made
  before the re-read starts.
- **A trim during a cold scan.** About once per 25,000 messages the trim drops the oldest lines of
  the log; if it lands during a cold scan, the scan keeps nothing and the request's old read runs.
  After a log trim, a Telegram conversation whose every message lay in the trimmed part shows no messages in the app, exactly as the old code does after any restart; Option C adds no blank the old code would not show, and the scan never records such a conversation as empty. Those Telegram messages remain in the conversation memory database and search (every message is written there when sent or received, independently of the log; verified on the live Studio data: all of the last 400 log rows are present in memory), and the approved follow-up CMT-2127 can surface them in the app. Native app conversations are stored separately and are not touched by the Telegram log trim.
- **A stalled disk.** A request with an uncached topic waits at most for the scan's 3.5 s deadline,
  then the old read runs (which a hung disk would hang, as in the old code). Requests whose topics
  are cached do not wait.
- **Same behavior as the old code** (labelled in the second review; not changed here):
  - A phone revoked while a request waits: the app's list already awaits other machines for up to
    5 s after admission, and the chat route already awaits the message-origin join after it.
  - The live config reader serves a cached value until the file's modification time changes; that
    holds for every live setting (`src/config/LiveConfig.ts`).
  - A same-length rewrite inside one change-time tick on a file system whose ticks are not whole
    milliseconds or seconds (APFS and ext4 keep nanoseconds).

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

## Review

One strict external review (Codex, read-only, prompt in the pull request) of the first commit found
seven serious issues; all are fixed in the second commit, each with a test that fails without its fix: the first-miss seed
duplicating saved tails (item 4), a same-length rewrite on coarse change times (the settle wait),
publication before the handle closed (the close now precedes the final check), an unregistered
topic saved back (the eviction count), cache hits waiting on a stalled scan, an unbounded round
(read to the size seen), and a grant removed during the chat wait (the access re-check). The minor
finding (topics asked during a scan going to separate scans) is fixed by the pending set.

A second strict review of the fixes found seven more. The five that were new differences from the
old code were fixed in the third commit. A narrow review of those fixes found nine more, mostly in
following a trim; the Chief of Staff ruled to remove the trim-follow (item 6) and the fourth commit
does so, with the deadline replaced by one wait budget per request and one tracked scan with a final
time check (item 8), the unfinished-line check made per request (item 7), and the baseline moved
only when the list really waits. Each has a test that fails without its fix. The three findings that
behave as the old code does are listed under Limits.

## Rollback

Set `telegramHistoryScan.offMainThread: false` (live), or revert the pull request. No state is
written; the cache is in memory and rebuilt on demand.
