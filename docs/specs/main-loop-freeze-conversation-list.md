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

1. The conversation list never reads the Telegram log on the request's turn. Building the rows for
   N topics costs O(N) in-memory lookups plus at most one indexed database seek per topic the
   adapter holds no entry for, with zero synchronous log reads (measured: 500 all-miss topics well
   under the 1 s goal).
2. The Cartographer boot scaffold is incremental: an unchanged node is read, not rewritten.
3. Logging a message never reads the whole log just to decide whether to rotate.
3a. The list's unread counts (the same request) never read the log synchronously either.
4. The boot-time node ABI probe does not run one blocking child process per node candidate on the
   server's main thread.
5. A guard test fails if a list of N topics reads the log synchronously at all (the old code reads it
   N+1 times); the one shared asynchronous warm-up read is distinguished from that.

## Design

### 1. Last-entry index in `TelegramAdapter` (the priority fix)

- New private map `topicLastEntry: Map<topicId, LogEntry>` — the newest logged entry per topic.
- Kept current by `rememberLoggedEntry` (the single place every successful append already passes
  through, both the shared-logger and legacy paths). One entry per topic, so it is NOT evicted by
  `unregisterTopic`; its size is bounded by the number of distinct topics ever logged, the same
  bound `topicContentVersion` already lives with.
- Filled from history by `buildLastEntryIndex()`: ONE streamed pass (`fs.createReadStream`, lines
  split per chunk), single-flight (concurrent callers share one promise), started lazily by the
  first `getTopicLastEntries` call. Parsing proceeds per stream chunk (64 KiB), yielding to I/O
  between reads.
  When the pass ends it fills only topics the map does not already hold — an entry appended while
  the pass ran is newer than anything in the file, so it is never overwritten. A missing log is not
  an error (`ENOENT` is silent; the index is complete and empty). Any other read error DISCARDS
  the partial result whole (merging it could pin a topic to an older entry that a later successful
  pass, which fills only absent topics, would then skip) and leaves the index incomplete. The retry
  is braked: the next build may start no sooner than 1 min after the failure, doubling per
  consecutive failure, capped at 30 min apart; the error is logged once. Log rotation during the
  pass is safe: rotation renames a new file into place, so the open stream finishes reading the old
  one, and anything appended meanwhile is already in the index.
- Memory: the index holds one entry per distinct topic ever logged (the same object the append
  path already created, shared with the tail cache when present): roughly the average entry size
  (~0.9 KB on Echo) times the topic count (hundreds to low thousands), i.e. about a megabyte,
  against the ~31 MB the old per-topic scans allocated on every list.
- Single writer: this adapter is the only writer of `telegram-messages.jsonl` (checked across
  `src/`: every other reference reads it; scripts and the lifeline reach messages through the
  server API, and per-bot adapters write their own `botStateDir`). So every append reaches
  `rememberLoggedEntry`, and a completed index stays current without re-reading the file. If a
  second writer were ever added, its appends would be missed by the index until the next server
  start, the same exposure the existing tail cache already has.
- Consistency: the tail cache and the index are written by the same single append path
  (`rememberLoggedEntry`), so where both hold a topic their newest entry is the same object.
  TopicMemory is consulted only for a topic the adapter has no entry for, never to override it.
- New public `getTopicLastEntries(topicIds)` → `{ entries, complete }`. Never touches the file:
  per topic it answers from the tail cache's last element, else the index. `complete` is true once
  the streamed pass finished.

### 2. The list producer reads the index, not history

`AgentServer.conversationFlatDeps.telegramTopics` now calls a small pure helper,
`buildTelegramListRows` (`src/server/telegramListRows.ts`), which:

- takes the mappings once and asks the adapter for every topic's newest entry in ONE call;
- fills any topic the adapter has no entry for — the index still warming up, or every line of
  that topic rotated out of the log — from the indexed TopicMemory store
  (`getRecentMessages(topicId, 1)`, an index seek on `idx_messages_topic(topic_id, timestamp)`) when
  that store is open, else leaves the preview empty. Filling regardless of warm-up keeps a preview
  from appearing during warm-up and then vanishing. Measured: 500 topics filled from a real store
  in well under the 1 s goal (unit test). TopicMemory rows carry the same visibility filtering as
  every other list row: the existing per-reader row filter runs after this producer;
- maps rows exactly as before (`topicDisplayName`, `deviceTextForRow(...).slice(0, 140)`).

Row shape, sort keys, cursor behavior, and `partial` semantics are unchanged. Two visible
differences: (1) a topic whose every log line has rotated out used to show no preview and no time
(and so sorted as inactive); it now shows its newest TopicMemory row's text and time and sorts by
that time, which is the truer answer; (2) before the streamed pass completes, a topic with no TopicMemory row shows no
preview/time for that request instead of blocking the server to compute it. Previews skip
`getTopicHistory`'s authorship join, which adds authorship fields only, never text or timestamp.

### 2b. The list's unread counts read the in-memory tail only

Review found a second path from the same request to the same synchronous scan: the unread counter
(`ConversationUnreadService.rowFields` → `sourceRows` → `telegram.history(topicId, 100/500)`) was
wired to `getTopicHistory`, so for a topic whose tail was not loaded (closed or cold) and whose
reader holds a read marker, it scanned the whole log on the request's turn. The old preview loop had
been filling the tail cache first, which hid this. Now:

- `TelegramAdapter.getCachedTopicHistory(topicId, limit)` answers from the in-memory tail only, or
  null when it is not loaded.
- `TelegramAdapter.warmTopicTails(topicIds)` loads tails in the background: ONE streamed pass for
  every topic queued before it starts (more passes only for topics queued while it ran), single
  flight, never replacing a tail another path loaded first, keeping (de-duplicated) any entry
  appended to a topic while it loads, discarding a pass that fails part-way, with the same retry
  brakes as the index.
- The unread source (`cachedTelegramHistory`, `src/server/telegramListRows.ts`) returns the cached
  rows, or null and queues the topic for a background load. `UnreadTelegramSource.history` may now
  answer null (its contract already said "never a disk scan"); `sourceRows` then answers null.
  For an unknown count, `rowFields` now answers unread-without-a-count only when the row's last
  activity is strictly after the reader's marker; activity at or before the marker answers
  `hasUnread: false, unreadCount: 0` (the pre-filter's 1 s margin otherwise passes fully-read
  conversations, which would flash an unread dot after every restart). Once the background load
  succeeds, later requests get the exact count; while it is pending or braked after a failure they
  keep the unknown answer.
- Read reports (`applyMark`, `holdsRef`) for a cold Telegram topic also see "not loaded": the mark's
  ceiling falls back to "now" rather than the newest held message, and a topic known only from the
  log answers as not held until loaded. Both are safe (a mark can never be in the future and only
  moves the reader's own marker) and resolve once the tail loads.
- Memory: a tail loaded this way stays until the topic's next `unregisterTopic`, like any tail the
  old preview loop loaded (it loaded one for every listed topic; this loads them only for topics
  whose reader holds a marker and that show activity near it). Every tail is a subset of the log's
  own lines, so all tails together never exceed the log (~31 MB on Echo).

### 3. Incremental Cartographer scaffold

`scaffoldChunked` pass 2 already yields between nodes (at most 50 ms per chunk), so it never held
the loop for seconds; its cost was rewriting every node file on every boot. It now reads each
existing node file once (one small synchronous read, replacing the old exists-check + read),
serializes the refreshed node, and writes it only when the bytes differ. An unchanged tree on
reboot writes no node file. The read, compare and write deliberately stay in ONE synchronous turn:
an await between them would let `setSummary`'s synchronous write land in the gap and be overwritten
by the scaffold's stale copy (a lost update an async draft of this change had; review caught it).
A corrupt node file reads as absent and is rewritten. `lastScaffoldUnchangedNodes` exposes the count
for tests and diagnosis. The walk (pass 1) and the streamed index (pass 3) are unchanged.

### 3b. Rotation check without a per-append read

A small `RotationLineCount` (in `MessageLogger.ts`, used by both the shared logger and the legacy
adapter path) learns the log's line count once, by counting newline bytes in the file (no decode,
no split), then adds one per append. The whole file is read only when the count passes the
100 000-line cap, to rotate it exactly as before, after which the count is set to the kept lines.
If the rotation's read or rename fails, the next attempt waits 1 000 more appends (1 % of the cap)
instead of re-reading the whole log on every append while the failure lasts; the count keeps
advancing, and a successful rotation clears the brake.
Below the size threshold the count is forgotten, so a log rotated or replaced elsewhere is
recounted. The adapter is the file's single writer (see §1), so the count tracks the file; were
another writer ever added, the count would lag and delay a rotation, and the rotation itself
always re-reads and re-counts.

### Simplest robust route

The simplest alternative is to serve every preview from TopicMemory alone and drop the in-memory
index. It was rejected as the primary source because TopicMemory is the less reliable of the two
on this fleet: it depends on the better-sqlite3 native module (the recurring ABI breakage after
Node upgrades leaves it closed for whole server lives), and its rows arrive by a dual-write that
can fail per message. The log is always present. So the index (one streamed pass, then free) is
the primary source and TopicMemory fills only what the index lacks; each covers the other's gap
with no extra machinery beyond one map and one background read.

### 4. Boot node ABI probe off the main thread

New `probeNodeNativeCompat(projectDir)` in `setup.ts` resolves the node candidate list
asynchronously (its `which node` and `brew --prefix node` — a Ruby script that can take a second
or more — run as async children) and runs the same `node -e require(<better-sqlite3 binary>)`
probe for every candidate plus the current symlink target with async `execFile`, at most four at
once (each probe is a whole node process; the PATH-derived candidate list is normally under ten).
`startServer` awaits it and passes both the answers and the candidate list to
`ensureStableNodeSymlink(projectDir, undefined, { nativeCompat, candidates })`, which then neither
re-resolves candidates nor probes (one millisecond-scale `which node` remains in `findNodePath`'s
fallback); `nodeCanLoadNativeModule` uses a known answer when present and
probes synchronously only for a path it was not given. The candidate assembly itself is shared
(`assembleNodeCandidates`), so the sync and async paths cannot drift.
Other callers (the lifeline, `instar setup`) pass nothing and behave exactly as before. A preserved
recovery bootstrap short-circuits the probe, as it does the symlink step.

No gate, filter, block or allow decision is added, removed or changed. The only fixed values introduced are tuning brakes on internal work, classified below; the 140-character preview cut, the 500-entry tail cache, the 20 MB size threshold and the 100 000 / 75 000-line rotation values are existing values, unchanged.

## Decision points touched

- Node ABI probe concurrency 4 — judgment-candidate; floor: at least 1 probe at a time, and an unprobed path falls back to the existing synchronous probe; arbiter: the boot path's measured latency. A tuning value, not a decision: each probe is a whole node process, the candidate list is PATH-derived and normally under ten, so 4 keeps most boots to one or two waves without a burst of ten processes. Changing it changes boot latency only.
- Rotation retry after a failed rotation: 1 000 appends — judgment-candidate; floor: rotation still happens once the failure clears, and the log only grows by the brake's width (1 % of the cap) meanwhile; arbiter: the next attempt. Brake required by No Unbounded Loops; the old behavior was a full read on every append.
- Index-build retry backoff 1 min doubling to a 30 min cap — judgment-candidate; floor: a failed build never certifies completeness and gap-fill keeps working meanwhile; arbiter: the retry itself. Brakes required by No Unbounded Loops; the values trade a slower recovery from a transient read error against repeated full reads of a persistently unreadable file.

## Out of scope, with routes

- `SessionManager.configHomeForSession` / `tmuxSessionExists` / `captureOutput` synchronous tmux
  spawns under `#monitorTick` and `StuckInputSentinel` (0.3-0.5 % each in the profile). These belong
  to the async-tmux work; queued with this profile as evidence. (feedback item fb-9193b40c-880)
- About fifteen callers of `getTopicHistory(topicId, 1_000)` (limit above the 500-entry cache; e.g.
  `notificationAlreadyDelivered`) do one synchronous full scan per call, and the search and pin
  routes' `getTopicHistory(topicId, 500)` scans once per closed topic (then caches until the topic
  is unregistered). Single-topic, per-request reads that did not appear in the freeze profile;
  queued with the evidence. (feedback item fb-9193b40c-880)
- The one-time message-dedupe seed (`seedMessageLogDedupe`) still reads the log synchronously once
  per process, at the first append. Bounded to one read per server life. (feedback item fb-9193b40c-880)
- `CiFailurePoller`'s `gh` launches are already async `execFile`; the profile's `spawn` frames
  under it are the unavoidable fork cost of a real child process, not a blocking wait.

## Multi-machine posture

Proxied-on-read. The index is derived, in-memory, operational state: a view of this machine's own
Telegram log with no durable store, the same posture as the existing tail cache. The pool-wide list
is served by the existing `?scope=pool` merged read, which calls each machine's own producer. This change does not alter
what a surviving machine can show for a dark peer (that is the existing pool read's contract);
it only makes each machine's own answer cheap. The Cartographer scaffold and
the node symlink are per-machine files. No notices, no URLs, no durable state added.

## Testing

- Unit `tests/unit/telegram-conversation-list-no-log-scan.test.ts`: N closed topics listed with zero
  synchronous log reads (and, for contrast, the old `getTopicHistory` path reads it per topic);
  previews filled after the streamed build; TopicMemory gap-fill during warm-up and for a topic
  with no log entry after it; an append during the build wins and survives `unregisterTopic`; a
  read failing part-way is discarded and the retry shows the newest entry; retries are braked;
  single-flight; missing log; 500 topics gap-filled from a real TopicMemory under the goal.
- Unit `tests/unit/telegram-unread-no-log-scan.test.ts`: the real `ConversationUnreadService` with the
  production unread source and a real adapter: a cold topic answers unknown with zero synchronous
  reads and queues one load; after it, the exact count (2) with zero reads; a fully-read cold topic
  shows no unread dot; an append during the
  load is kept once; several cold topics share one pass; a failed load is braked.
- Unit `tests/unit/message-log-rotation-no-per-append-read.test.ts`: 200 appends above the size
  threshold read the file once (the seed), not 200 times; rotation still happens at the cap and
  keeps the newest lines; a failing rotation is braked (100 appends, zero reads) and recovers.
- Unit `tests/unit/cartographer-scaffold-incremental.test.ts`: unchanged tree → zero node writes; a
  new file → exactly two node writes (the file and its parent dir); a summary authored between
  scaffold chunks survives; corrupt node rewritten.
- Unit `tests/unit/node-symlink-async-probe.test.ts`: with probed answers and candidates, zero
  synchronous probes and no synchronous `brew`; without them, behavior unchanged.
- Integration `tests/integration/conversation-list-no-log-scan.test.ts`: real router + real adapter
  over HTTP, 120 closed topics, zero synchronous log reads, previews after the build.
- E2E `tests/e2e/conversation-list-no-log-scan-alive.test.ts`: AgentServer production constructor
  with a real adapter and the read-marker store; the route answers 200 with every topic and zero
  synchronous log reads (verified to fail against the old producer: 81 reads for 80 topics), and
  the wired unread source answers null for a cold topic, then its rows after the background load,
  with zero synchronous reads throughout.

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
- **graduation criterion:** over 7 days on the Echo Studio after the release, no event-loop freeze of 5 s or more whose saved profile shows `scanLogForTopic`, `maybeRotateLog`/`maybeRotate` or `CartographerTree.atomicWrite` as its top frame, and no lease renewal missed for a freeze. Zero observed freezes with no profile captured is not a pass on its own: at least one profile of a normal list poll is captured and shows no full-log read.
- **ladder:** none (an always-on repair of an existing read path, no feature flag to climb)
- **dark-window:** none — live on release. If the criterion is not met within 14 days, the reason and a new date are recorded on fb-52447f16-7d3.

## Rollback

Pure code change. Revert the commit and ship a patch; no persistent state, config, or migration.

## Open questions

*(none)*

## Frontloaded Decisions

- Gap-fill source for a topic the adapter has no entry for: TopicMemory when open (always, not only during warm-up, so previews do not flip), else an empty preview for that request. Decided now.
