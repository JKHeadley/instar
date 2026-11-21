---
title: "Main-loop freezes: the conversation list re-read the Telegram log per topic"
slug: "main-loop-freeze-conversation-list"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "main-loop-freeze-conversation-list.eli16.md"
status: "converged"
feedback: "fb-52447f16-7d3"
review-convergence: "2026-11-21T10:26:12.600Z"
review-iterations: 3
review-completed-at: "2026-11-21T10:26:12.600Z"
review-report: "docs/specs/reports/main-loop-freeze-conversation-list-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 1
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "echo (agent self-approval per 2.0 Rule 82 after reading the convergence report): touches neither the constitution nor a CODEOWNERS path; owner-approved 24h Studio outage repair, lead run topic 145840"
---

# Main-loop freezes: the conversation list re-read the Telegram log per topic

## Problem

On 2026-11-21 the Echo Studio server (instar 1.3.1944, Node 24) froze its event loop for 20-30 s
at a time (08:44Z, 08:55Z, 09:15Z, 09:47Z). Each freeze cost the lead machine its lease renewals
and stopped the merge line. A 120 s CPU profile with call chains taken during the 09:47Z freeze
(saved under the run's scratchpad as `freeze-profiles/CAPTURED-2026-11-21T09:46:44.txt` plus the
`.cpuprofile`) attributes:

| Self time | Frame (caller chain) |
|---|---|
| 12.3 % + 6.0 % + 1.0 % | `TelegramAdapter.scanLogForTopic` / `readFileSync` / `readFileUtf8` ← `getTopicHistory` ← `AgentServer.conversationFlatDeps.telegramTopics` ← `localConversationListPage` ← `localListPage` |
| 4.9 % + 3.4 % + 3.0 % + 1.4 % + 0.6 % + 0.4 % + 0.3 % | `CartographerTree.scaffoldChunked` → `atomicWrite` (sync write + rename) / `readNodeFile` (sync) / `readdir` / `lstat` / prune unlink |
| 0.4 % | `setup.nodeCanLoadNativeModule` ← `ensureStableNodeSymlink` ← `startServer` (sync `node -e require(...)` per node candidate) |

One layer below, review found a second instance of the same class on the write path: above the
20 MB size threshold, the message-log rotation check (`TelegramAdapter.maybeRotateLog` on the legacy
path Echo uses, `MessageLogger.maybeRotate` on the shared path) reads and splits the WHOLE log on
every append, yet only rotates past 100 000 lines. Echo's live log was 30.8 MB / 36 021 lines
(~856 bytes per line), so every logged message did a ~31 MB synchronous read, and would keep doing
so until the log reached ~85 MB.

An earlier profile right after boot had 72 % of its samples in `spawn`, partly from the same
boot-time node probe.

### Root cause (the list)

`GET /mobile/conversations` (the phone and Mac app's conversation list; polled) builds one row per
Telegram topic in `getAllTopicMappings()`. That set includes every topic with a stored name, not
only topics with a live session — on Echo, hundreds. For each it called
`getTopicHistory(topicId, 1)`. `getTopicHistory` serves from an in-memory tail cache, but the cache's
one-time batch seed covers only LIVE topics (`topicToSession`). Every other topic misses and runs
`scanLogForTopic`: a synchronous `readFileSync` + split + JSON parse of the whole message log (31 MB
on Echo; the 75 000-line keep target is ~64 MB at Echo's line size). Worse, `unregisterTopic` evicts the topic's cache (a deliberate memory bound),
so every topic whose session closes goes back to costing a full read on the next list. A list of N
uncached topics therefore read the log up to N times on one turn of the loop — the 20-30 s freeze.
The cache is cold after every server start and is re-emptied topic by topic as sessions are reaped,
and the Studio restarted repeatedly that morning. The profile spans 120 s around the 09:47Z freeze
and its frame percentages are aggregates, so the list scan is the leading explanation (the largest
self-time in the window, by a wide margin) rather than an isolated proof of each 20-30 s stall; the
production outcome is judged by event-loop delay and lease renewals after release (Evidence bar). The per-append rotation read adds a steady ~31 MB read per logged message on
top.

## Goal

No request or periodic task blocks the main loop for more than about one second. Concretely:

1. The conversation list never reads the Telegram log synchronously on a request's turn. It waits
   (bounded) for one streamed load, then builds N rows from memory.
3. Logging a message never reads the whole log just to decide whether to rotate.
3a. The list's unread counts (the same request) never read the log synchronously either.
5. A guard test fails if a list of N topics reads the log synchronously at all (the old code reads it
   N+1 times); the one shared asynchronous warm-up read is distinguished from that.

## Design

### 1. An in-memory view of the log replaces the file scan

Two earlier designs were replaced after whole-diff outside review. A separate latest-message index
with fallbacks changed unread and pagination answers; filling the tail cache directly changed its
eviction, row shapes and rotation behavior. This design leaves the tail cache and every reader's
rules as they were and replaces only the slow step underneath them.

- `TelegramAdapter.logView` holds the log file's newest 500 rows per topic, exactly as a file read
  parses them (the same topic matcher; malformed lines skipped).
- `scanLogForTopic` (limit up to 500) and the first tail seed read the view when it exists. The tail
  cache, its eviction on `unregisterTopic`, and the row each reader sees are otherwise unchanged.
- One pass of small awaited reads builds it (`loadHistory`), single flight. It reads to the end of
  the file and publishes in the same turn that confirms that end, so no append can fall between.
  After that each append adds its row in persisted JSON shape. The pass also seeds append dedupe.
- An append onto a torn last line (no newline) makes one unreadable line in the file, so the view
  is dropped and re-read rather than guessing what the file now holds.
- A rotation (either logger path) drops the view and rebuilds it, so a cold read cannot seed a row
  the file no longer holds. A pass that read a replaced file is discarded and re-read.
- A missing log is an empty view. A failed pass is discarded whole. There is no retry timer: a later
  request may start another pass after 5 s, doubling to 5 min.

### 2. Conversation reads wait for the view, boundedly

- The list, a read report that names a Telegram conversation, and `GET /telegram/topics/:id/messages`
  (the app's chat history; a Bearer scroll-back needs no view) wait after their own validation, up
  to 15 s (4 s for a peer's fan-out read, inside its 5 s budget) and off the event loop. A first-time reader's baseline is set on arrival, before the wait. If the view is still
  unavailable the list and chat answer `503 conversations-loading` with `Retry-After: 5`; a read
  report proceeds with its ordinary per-mark results.
- Scroll-back uses `getTopicHistoryBeforeAsync`, the same backward read awaited per 1 MB block.
- The list and unread counter use `getTopicTailRows`, which skips the authorship join: it adds only
  authorship fields and can synchronously parse its ledger.
- The conversation-graph inventory starts after the view first loads, or after a failed load, when it runs on the ordinary read path as it always has.
- Where the app is enabled the view loads at server start.

Row shape, previews, order, cursors, unread counts and dividers are intended to be unchanged; the
old-versus-new client diff on identical fixture data is the proof.

### 3b. Rotation check without a per-append read

A small `RotationLineCount` (in `MessageLogger.ts`, used by both the shared logger and the legacy
adapter path) learns the log's line count once, by counting newline bytes in the file (no decode,
no split), then adds one per append. The whole file is read only when the count passes the
100 000-line cap, to rotate it exactly as before, after which the count is set to the kept lines.
If the rotation's read or rename fails, the next append tries again, exactly as the old code
did, so every rotation happens at the same append and keeps the same lines. The count is never
below the file's real count of non-empty lines, and is recounted after a failed append.
Below the size threshold the count is forgotten, so a log rotated or replaced elsewhere is
recounted. The adapter is the file's single writer (see §1), so the count tracks the file; were
another writer ever added, the count would lag and delay a rotation, and the rotation itself
always re-reads and re-counts.

### 4. Failure handling added after review

- A rotation while a load is closing its file handle is read again in the same load, so a load
  never finishes with no view (that would be a blank chat).
- An append that fails part-way drops the view and re-reads the file, so a message is never
  visible only in memory.
- A rotation that fails is retried on the next append, as before, so it keeps exactly the lines
  the old code keeps.
- A peer that answers `503 conversations-loading` is reported in `pool.failed` as `loading`, not
  `off`. The pool list re-checks the view after the peers answer and before its unread and pin passes.
- A forwarded read report waits at most 4 s, inside the sender's 5 s budget.

### 5. Off switch

`telegramHistoryView.enabled` (default on). Set to `false`, every read returns to the old path with
no code change: no view, no waits, the synchronous scroll-back, and the joined history read for the
list and unread counter. It is read live through LiveConfig where available (otherwise from the
config at boot). Turning it off drops the view; turning it back on rebuilds it from the file.

### Split out

The boot-time changes (the Cartographer scaffold writing only changed node files, and the async
Node ABI check) moved to their own pull request, #3601, at the operator's request. This change is
only the conversation-list, chat-history and message-save paths.

### Simplest robust route

Replace only the expensive file scan with an in-memory copy of what it would return. No new data
source, no provisional answer and no change to the tail cache's rules.

No gate, filter, block or allow decision is added, removed or changed. The only fixed values introduced are tuning brakes on internal work, classified below; the 140-character preview cut, the 500-entry tail cache, the 20 MB size threshold and the 100 000 / 75 000-line rotation values are existing values, unchanged.

## Decision points touched

- Request waits 15 s (4 s for a peer machine's request) — judgment-candidate; floor: on expiry the request answers a retryable 503 and never reads the log synchronously; arbiter: the client's retry. The 4 s keeps a peer's answer inside the 5 s pool budget.
- History-load retry backoff 5 s doubling to a 5 min cap — judgment-candidate; floor: a failed load publishes nothing and readers get a retryable answer; arbiter: the retry itself. Brakes required by No Unbounded Loops; the values trade a slower recovery from a transient read error against repeated full reads of a persistently unreadable file.

## Known limits (accepted)

- Replacing the log file by hand while the server runs is unsupported: the view and the rotation
  line count follow the file the server writes, and catch up at the next rotation or restart.
- Timing budgets: a peer that needs more than 4 s to load reports `loading` for that request; the
  15 s wait can race a shorter server request timeout; the graph inventory waits for the first load
  or its first failure. In each case the answer is late or "try again", never different data.
- About fifteen callers of `getTopicHistory(topicId, 1_000)` (above the 500-row view) and an actual
  rotation still read the file synchronously, as before. (feedback item fb-9193b40c-880)

## Multi-machine posture

Proxied-on-read. The tail cache is derived, in-memory, operational state: a view of this machine's own
Telegram log with no durable store, the same posture as the existing tail cache. The pool-wide list
is served by the existing `?scope=pool` merged read, which calls each machine's own producer. This change does not alter
what a surviving machine can show for a dark peer (that is the existing pool read's contract);
it only makes each machine's own answer cheap.  No notices, no URLs, no durable state added.

## Testing

- Unit `tests/unit/telegram-log-view.test.ts`: answers equal a real file read; closing still evicts with no file read; appends and rotation stay correct; failed reads discarded, braked and self-retried; bounded wait; async scroll-back.
- Unit `tests/unit/message-log-rotation-no-per-append-read.test.ts`: 200 appends above the size
  threshold read the file once (the seed), not 200 times; rotation still happens at the cap and
  keeps the newest lines; with failures injected into the read or the rename, the kept lines equal
  an oracle replay of the old algorithm on the same appends and failures.
- Integration `tests/integration/conversation-list-no-log-scan.test.ts`: a cold list pages all topics in order; chats and scroll-back avoid synchronous log reads; unavailable history answers a retryable 503.
- E2E `tests/e2e/conversation-list-no-log-scan-alive.test.ts`: production `AgentServer` and real adapter; concurrent cold requests share one load, with no synchronous log read.

## Evidence bar and live proof

- The tests prove the cause is gone (zero synchronous log reads where the old code did N+1). They
  do not replay the production workload's timing.
- The live proof is the production signal itself: after this ships to the Studio, the lease
  renewals that the freezes cost stop being missed and the event-loop freezes stop. The lead run
  (topic 145840) watches for the absence of the 20-30 s freezes on the next release; a recurrence
  is captured with the same saved-profile method and reopens fb-52447f16-7d3.
- A user-role drive of the real phone/Mac list is not possible from this build host (no app
  toolchain on the Studio); the route the apps call is exercised end to end through the production
  `AgentServer` constructor instead, and the response shape is unchanged.

## Maturation plan

- **test-agent-live:** the e2e test boots the production `AgentServer` with a real Telegram adapter and read-marker store and drives the list route and the unread wiring; that is the throwaway-agent proof.
- **dev-agent-live:** live on Echo from the release that carries it (no flag: it is a repair of an existing read path). The lead run (topic 145840) watches the Studio for the 20-30 s freezes and missed lease renewals over the following days.
- **fleet:** the same release, ungated.
- **graduation criterion:** over 7 days on the Echo Studio after the release, no event-loop freeze of 5 s or more whose saved profile shows `scanLogForTopic`, `maybeRotateLog`/`maybeRotate` as its top frame, and no lease renewal missed for a freeze. Zero observed freezes with no profile captured is not a pass on its own: at least one profile of a normal list poll is captured and shows no full-log read.
- **ladder:** none (an always-on repair of an existing read path, no feature flag to climb)
- **dark-window:** none — live on release. If the criterion is not met within 14 days, the reason and a new date are recorded on fb-52447f16-7d3.

## Rollback

Pure code change. Revert the commit and ship a patch; no persistent state, config, or migration.

## Open questions

*(none)*

## Frontloaded Decisions

- Load behavior: requests wait up to 15 s for one streamed load, then answer retryable 503, rather than showing provisional data or scanning the log.
