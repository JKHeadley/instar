---
title: "Topic history import — restore recovered conversation history without disturbing live order"
slug: "topic-history-import"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity — a machine never loses INFORMATION; this restores history a machine lost from copies its peers held"
eli16-overview: "topic-history-import.eli16.md"
status: "converged"
approved: true
approved-by: "echo (agent self-approval per 2.0 Rule 82: not a constitution or protected-list change) after reading the convergence report docs/specs/reports/topic-history-import-convergence.md; the build was requested in the owner-approved Studio outage repair run (2026-11-20)"
review-convergence: "2026-11-20T21:50:36.349Z"
review-iterations: 6
review-completed-at: "2026-11-20T21:50:36.349Z"
review-report: "docs/specs/reports/topic-history-import-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Topic history import

## Problem

A machine rebuild (Mac Studio, 2026-11-20) lost part of the agent's Telegram and
app conversation history. A recovery pass collected 13,946 messages from the
other machines' logs into one deduplicated file
(`.instar/recovery/telegram-messages-recovered.jsonl`, 167 topics). There is no
supported way to put them back:

- `POST /topic/rebuild` deletes every row in TopicMemory and re-reads the live
  log (`telegram-messages.jsonl`) plus the Slack log. It cannot add rows that are
  in neither.
- Appending the recovered rows to the live log is wrong in three ways, measured
  against the live data:
  1. TopicMemory's id-ordered readers (`lastMessageIdByRow`, `messagePrecedes`,
     `countMessagesAfter`, `getAgentMessagesBefore`, the user-corpus watermark,
     `indexPage`) treat SQLite row order as message order. Rows appended now get
     the highest row ids, so an August message would read as the newest message
     of its topic. 59 of the 164 importable topics have recovered rows that
     interleave with rows already in the store (topic 29723: every one of its
     3,155 recovered rows falls inside the live range).
  2. Several readers tail the live log as "what just happened"
     (CommitmentSentinel, CoherenceMonitor, the commitment-detection job, the
     Jev review-flag shadow, the message-evidence authority). Old rows at the
     tail would be re-read as new messages: re-detected commitments, re-judged
     replies, and old operator words presented as fresh evidence.
  3. A concurrent live append while a script rewrites the file can be lost.

## Design

### Existing paths, and why neither is enough

- `POST /topic/rebuild` replays only the live logs.
- `scripts/lib/topic-memory-importer.mjs` (the 2026-05-20 MTProto backfill)
  writes out of process with `INSERT OR IGNORE`: old rows land with the newest
  row ids (problem 1 above), and nothing it writes survives a rebuild, because
  it is in no source log.

### Where the rows live

TopicMemory (SQLite) is a derived index whose sources of truth are the message
logs. Accepted rows are published as one immutable batch file per import under
`<stateDir>/topic-history-imports/<importId>.r<rows>.jsonl`. The file is
written to a temporary name, fsynced, renamed into place, and the directory is
fsynced. The row count in the name lets replay detect a batch that later lost
lines (even a truncation at a line boundary or an emptied file) or that holds
fewer distinct rows than declared. That counts as damage (`unreadable`), and a
rebuild refuses on it. Only a published name is read: any other `.jsonl` file
in the folder supplies no history and is counted as damage. The audit line is
fsynced the same way, so it survives a power loss along with its batch. Replay
reads only published names, so a crash mid-write can never leave a half batch
that replay would trust. The live log is never written by this feature, so no
tail reader ever sees an imported row, and no live append can race the import.

### Row admission (the server's own schema)

One pure validator, `validateImportRow`, admits a row only when:

- `topicId` is a positive safe integer (a Telegram topic). A row with no topic is
  refused as `unroutable`.
- `messageId` is a positive safe integer (a Telegram message id, keyed by
  `deriveRowKey({channel:'telegram'})`, the §14 rule the live writer uses:
  `message_id` = the id, `channel_message_id` = its string). A string id
  starting `app:` is refused as `app-message` (below). Anything else, for
  example a test fixture id `g3test-1`, is refused as `bad-id`.
- `text` is a non-empty string (no per-row cap: the live log has none, and the
  file bound below caps memory). `timestamp` parses, is not more than 5 minutes
  in the future, and is stored as canonical ISO-8601 UTC, because readers order
  by the timestamp text. `fromUser` is a boolean.
- Optional fields keep their types (`sessionName`, `senderName`,
  `senderUsername`, `telegramUserId`, `forwarded`). A `conversationKey`, when
  present, must equal `telegram:<topicId>`. A wrong type is refused as
  `bad-field`, never coerced. Other fields (`provenance`, `messageLink`,
  `attachments`) are ignored. `recoveredFrom` is kept in the batch file only.
  `privacy_scope` takes the store default, `private`.

**App messages are not imported into TopicMemory.** All 84 distinct app
messages in the recovery file (the `app:` ids) were verified present in the
Studio's own app conversation store (`.instar/app-conversations/`), which is
where the live app path keeps them. The live row writer never puts a
platform-keyed app event into TopicMemory (`writeAppConversationRow` answers
`not-this-channel`). Keying one into a Telegram topic would put a ~1.7e15
message id among ~1e5 Telegram ids, which would freeze the message-id summary
cursor (`getMessagesSinceSummary`). They are refused as `app-message`, counted,
and named in the response. That includes the 19 with no topic.

**Authority narrows, never widens.** Every imported row carries
`origin = 'imported'`, a new value of the existing row-origin label (§8; it
already holds `relay` and `a2a`). It also carries `forwarded = true` when the
source said so and `forwarded = unknown` (NULL) otherwise, never `false`.
Effects, each verified in code:

- standing authorization, the message-evidence authority and topic-creation
  provenance require `forwarded === false`, so they never count a recovered row;
- the user corpus (`classifyRow`) labels an imported operator row `recovered`
  with `authority: 'none'`. So a recovered operator message never becomes a
  protected operator row, even when its `telegramUserId` resolves to the
  owner. The corpus row query (`getUserCorpusRows`) admits origin-labelled
  rows only for `relay`/`a2a`, the other agents. So the agent's own recovered
  replies (about 6,000 rows) never enter the person's corpus;
- `getAgentMessagesBefore` skips origin-labelled rows, so a recovered agent
  message is never offered as a stub referent. The consequence: a live
  operator reply whose real preceding agent message was recovered is offered
  an older live agent message as its referent. This is acceptable, because
  stubs are a labelling aid with a validator, not authority;
- the peer row carrier never carries an imported row (`recent`, `ids` and push
  reads skip `origin = 'imported'`). Each machine imports for itself, and a
  plain insert on the receiver would land the row as newest.

### Dedupe and precedence

Inside one batch, by `(topicId, message_id)`. Against the store by the
`UNIQUE(message_id, topic_id)` key and by `channel_message_id`. Against every
already-published batch too, so a batch published before a crash is
re-applied by replay and never accepted twice. A duplicate is counted, never
rewritten.

Live precedence, in both arrival orders:
- live first: the import counts the key `duplicate` and never rewrites it;
- import first: a later LOCAL live delivery of the same message (this
  machine's Telegram log, `onMessageLogged`) goes through
  `writeTelegramLogRow`. When the keyed write answers `duplicate`, it calls
  `TopicMemory.supersedeImportedRow`, which replaces the imported copy's body,
  sender and provenance with the live copy's and clears the `imported` label.
  The row keeps its position. Only this path supersedes, because a local
  Telegram delivery is the source the restored copy stood in for. Every other
  writer, the peer row carrier above all, uses plain `writeRow`, where an
  existing label is never changed. A carried row can therefore never strip the
  `imported` label or widen a restored row's authority. The existing rule
  holds: a label only narrows. A delayed local delivery then reaches the user corpus
  through the capture path, which re-lists that exact message
  (`TopicIntentCapture` → `userCorpus.refresh(topicId, { messageId })`), so
  its label follows the live copy;
- rebuild: the live logs replay BEFORE the batches, and the merge keeps the
  stored copy, so a copy that reached the live log wins there too. A copy
  that arrived only through the peer row carrier is in no log, so a rebuild
  puts the batch copy back as `imported`. That loses nothing compared with
  before this feature, because carried rows were already lost on rebuild.
A test pins import-then-live.

### Concurrency

Imports and `TopicMemory.rebuild()` run one at a time in the server process,
on one promise chain (`withTopicHistoryLock`). An import's admission, publish
and merge are a single critical section. A rebuild cannot have an import's
merge land between its delete and its live replay; if it could, the imported
rows would sit among a partial live set, and the re-apply would then find them
present and never fix the order. Inside the merge,
better-sqlite3 is synchronous and Node runs one JavaScript thread, so the live
dual-write (`onMessageLogged` → `insertKeyedMessage`) runs before or after a
topic's transaction, never inside it. A live row written after a topic's merge
gets a higher row id, which is correct: it is the newest. SQLite's write lock
covers any other process, such as the backfill script.

### Timestamp-ordered merge (the core)

`TopicMemory.mergeTopicHistory(topicId, importedRows)` re-sequences ONE topic
inside ONE synchronous transaction. Callers yield to the event loop
(`setImmediate`) between topics, so the loop is held for one topic's merge at
a time. The largest topic here holds about 12.6k rows.

1. `importedRows` is EVERY published imported row of the topic, already in the
   store or not. The topic's other stored rows are its live rows.
2. Live rows keep their exact relative order. Imported rows are taken in the
   total order (timestamp, then message id). Each imported row is placed before
   the first live row whose timestamp is strictly later (`mergeSequence`).
   Because live order is preserved exactly, row ids follow message time only
   as far as the live rows themselves do. Live timestamps `[10, 5]` plus an
   imported `[7]` give `[7, 10, 5]`. A test pins this placement rule. The
   result depends only on the live sequence and the SET of imported rows, so
   importing in two batches and replaying everything after a rebuild give the
   same order. A test pins this.
3. If no imported row is missing, the topic is not touched. Otherwise the
   topic's rows are deleted and re-inserted in merged order. Row ids then ascend
   in message-time order, the FTS5 triggers keep the search index in step, and
   `topic_meta` is recomputed.

Readers that hold row ids, checked: the user-corpus watermark re-lists
idempotently (a row whose quote and label are unchanged is left alone; its
stored `rowId` is informational). The meaning-search embedding sweep cursor is
in memory and catches up as it pages. `POST /topic/rebuild` already renumbers
every topic the same way. `countMessagesAfter` may report a context layer as
behind after an import placed rows after its stamp. That is true (new rows
exist), and the refold it prompts is correct. Topic summaries key on message
ids, and imported Telegram ids sit inside the Telegram id range, so the
summary cursor keeps working.

### Durability across a rebuild

`importAllLogs()`, which boot and `rebuild()` both call, re-applies every published
batch through `mergeTopicHistory` after the live logs are replayed. Each
topic's presence check and merge run in their own try/catch: a topic that fails rolls back whole, is
logged and returned in `failedTopics`, and the other topics still restore. On a
normal boot every imported row is present, so this is a read of the batch
files plus one presence query per topic. After a rebuild it restores the
imported rows in time order. The corruption rebuild inside `open()` is followed at
boot by `importAllLogs()`, which re-applies them. `rebuild()` keeps its
refuse-to-wipe guard. A batch never licenses deleting live rows: batch rows
count as restorable only when the store holds nothing but imported rows, so
with live rows present and no log to replay them the rebuild still refuses
(`no-source-log`). A damaged batch line is a row a rebuild could delete and
never restore, so a rebuild also refuses (`import-batch-unreadable`) and
deletes nothing.

### Route

`POST /topic/import`. Bearer token only: a paired phone (owner, team or MSP) is
refused 403 `agent-token-required`. Its request-timeout budget is 300 s
(`TOPIC_IMPORT_TIMEOUT_MS`), because the default 30 s would answer 408 in the
middle of a merge.

Body:
- `file`: a path relative to the state dir. It is resolved with realpath and must
  stay inside it, so `..`, an absolute path or a symlink out is refused 400. It is
  read as JSONL.
- or `rows`: an inline array, bounded by the normal request body limit;
- `source`: a short label recorded in the audit (default `api`);
- `dryRun`: when true, validate, dedupe and report, and write nothing.

Response: `{ importId, dryRun, received, accepted, duplicate, rejected:
{reason: n}, rejectedSamples (≤20, reason + short detail, never message text),
perTopic: { "<topicId>": { accepted, duplicate } }, merged: { topics, inserted },
stats }`. `stats` is the existing `TopicMemory.stats()`.

Write order on a non-dry run, chosen so every crash point leaves a record:

1. Audit line, `phase: "accepted"`, to
   `<stateDir>/logs/topic-history-imports.jsonl`: importId, time, source, file
   name, counts and per-topic counts. Never message text.
2. The batch is published atomically. The write loops until every byte is
   written (`writeSync` may write short). A directory fsync failure
   propagates, except on Windows, which cannot fsync a directory. Each row
   carries `importId`.
3. Each affected topic is merged, with a yield between topics.
4. Audit line, `phase: "merged"`, with the merge result.

A crash after (2) is healed by the next boot's re-apply. A merge that throws
while the server stays up is healed by an identical retry. A row already in a
published batch but missing from the store is counted `duplicate`, and its
topic is re-merged before the response. The row-level `importId` and the
`accepted` line say where those rows came from.

Bounds: a file is refused above 128 MiB or 100,000 rows (413 `too-large`,
nothing written). The same 100,000-row bound applies to the cumulative rows of
every published batch, and a 128 MiB budget applies to their cumulative
serialized bytes, text and every stored field included (both checked on a
dry run too). So repeated imports cannot
grow the boot-time read without bound. Only a missing batch directory reads
as empty. Any other listing error propagates, so an unreadable archive never
looks like an empty one, and a rebuild fails before it deletes anything. Basis: external-constraint. Evidence: published batches are
read whole on every import and at boot, and the recovery file is 13,946 rows
(~12 MiB), so the bound is about 7 times the real input.

Team scope: the route writes each row into the topic named by its own
`topicId`. It never moves a message between conversations, so it cannot widen
who can read a message. A bearer-token caller already has full access.

Idempotent: a second identical call accepts 0, reports every previously
accepted row as `duplicate` (invalid rows keep their rejection reasons), and
publishes no batch.

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| Row admission (`validateImportRow`) | invariant | basis: enumerable-domain; evidence: the messages table's column types and UNIQUE(message_id, topic_id), and deriveRowKey's Telegram rule, admit a fixed set of shapes. Schema check against the store's own column types and the §14 key rule: a row has a key the store can hold or it does not. Nothing is interpreted; each refusal is counted by reason and the caller can fix and re-send. |
| Provenance on an imported row (`origin = 'imported'`, forwarded narrowed, user-corpus label `recovered`) | invariant | basis: irreversible-consequence; evidence: a recovered row counted as a fresh owner instruction could authorize an action that cannot be undone, and recovered provenance cannot be re-proven. Narrow-only by construction: it can remove authority, never grant it, so there is no judgment to make. |
| Route access (bearer token only) | invariant | basis: irreversible-consequence; evidence: written history is durable and replayed on every rebuild, and a team phone writing into another person's conversation could not be cleanly undone. The existing principal check (`principalOf(req).kind === 'token'`); a paired device never writes history. |

## Signal vs authority

No new detector, gate, sentinel or blocking authority is added. The route writes history; it does not gate, block or filter anything. The one
authority-relevant choice (forwarded provenance) only narrows: recovered rows
can never establish operator authority.

## Multi-machine posture

This feature serves the multi-machine standard: it is how one machine gets
back information its peers still hold. It does not change where history
lives. The live message log and TopicMemory are per machine today. That
pre-existing gap is why the rebuild lost history, and it is filed as
feedback fb-33f27f6a-03c. The route works the same on any
machine: run it with a file of rows from any peer, and that machine ends up
holding them.

machine-local-justification: operator-ratified-exception — artifact: feedback fb-33f27f6a-03c (the replication gap this repair works around; the per-machine log predates this spec and is not introduced by it).

TopicMemory and its source logs are already per machine (each machine polls,
logs and indexes its own copy, and this feature changes nothing about that).
The other machines still hold these rows in their own live logs, which is
where the recovery file came from, so nothing is stranded. A machine that
later needs the same history runs the same route with the same file; the key
rule guarantees every machine derives identical keys for the same message.
Bodies can differ where a machine already held its own live copy, because on
each machine the local copy takes precedence. No user-facing notice is produced and no URL
is generated.

## Frontloaded Decisions

1. **Separate imported log, never the live log.** Decided: tail readers must
   never see recovered rows as new, and no live append may race the import.
2. **Per-topic renumber inside one transaction** rather than global renumber
   or negative row ids. Negative ids would only be correct when every
   recovered row is older than every live row of its topic, which is false for
   59 topics. A global renumber touches topics the import does not affect.
3. **App rows are refused as `app-message`**, not keyed into Telegram topics.
   They are already in the app conversation store (verified 84/84 on the
   Studio), and keying them into a Telegram topic would stall the summary cursor.
4. **Recovered rows carry `origin = 'imported'` and never `forwarded = false`.**
   Authority narrows. The user corpus gets a `recovered` label.
5. **The 445 transcript-quoted rows are never imported** by this route, by
   construction: they have no message id and are refused as `bad-id` if sent.

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** the E2E lifecycle test is the throwaway agent: a real
  server on the production boot path, a real import, a restart and a
  destructive rebuild.
- **dev-agent-live:** the Mac Studio Echo, the agent that lost the history. After the
  next planned restart, the import runs against
  `.instar/recovery/telegram-messages-recovered.jsonl`: a dry run first, then the real
  run. Per-topic counts are recorded in the PR.
- **fleet:** the same release. The route does nothing until it is called, so
  there is no staged switch.
- **graduation criterion:** on the Studio, `/topic/search` scoped to topic
  135786 returns a hit for a word that appears only in a recovered row. For
  every watched topic (135786, 141469, 141133, 141868, 138345, 142908), the
  newest message in recent history is the same message before and after the
  import. A second identical import accepts 0.
- **dark-window:** none. The route is live on release and inert until called.
- **ladder:** not applicable: no staged rollout of its own, it rides the release train and a revert undoes it

## Rollback

Code revert: the batch files are no longer read. The rows stay in TopicMemory
until the next `/topic/rebuild`, which drops them. A reverted build reads
`origin = 'imported'` as unknown (`coerceTopicRowOrigin`), so before that
rebuild those rows lose their label, but they keep `forwarded = unknown`.
Data rollback without a code change: move `topic-history-imports/` aside and
call `/topic/rebuild`. Neither touches the live log.

## Left behind

- A bearer-token caller could forge a row with a not-yet-used Telegram id and
  a past timestamp. Accepted: the bearer token already grants full write
  access, the row is labelled `imported` with no authority, and the genuine
  message supersedes it when it arrives.
- The realpath check, then the read (TOCTOU). Accepted: a swap would need
  write access to the state dir, which is the bearer holder's own.
- A row that reached this machine only through the peer row carrier is in
  no log. Importing its recovered copy counts `duplicate`, so a later rebuild
  still loses it. Accepted: carried rows were lost on rebuild before this
  feature, and the carrier re-sends recent rows on its next pull. Making
  every carried row durable is the log-replication work tracked as
  fb-33f27f6a-03c.
- After a partial live supersede (some restored rows of a topic later
  delivered live), a rebuild can order the topic differently from before it:
  the live log replays the delivered rows in log order. Accepted: the
  delivered rows are the same messages with the same live content, only
  their order among old rows of the same conversation differs, and recovered
  rows are weeks old, so this arrival pattern is not realistic.
- An imported row stamped up to 5 minutes in the future (the clock-skew
  allowance), followed by a live row with an earlier stamp, sits before that
  live row until a rebuild re-sorts it by time. Accepted: it is a skew
  window of minutes, the recovered rows are historical, and both orders hold
  the same messages.
- A damaged batch makes every later rebuild refuse until the file is
  repaired or moved aside. This fails closed on purpose. An import heals the
  data itself: a row missing from both a damaged batch and the store is
  accepted again into a new batch, which also means a "second identical call
  accepts 0" holds only while no batch has lost rows.
- Event-loop hold: one topic's merge is one synchronous transaction, so it
  holds the loop for that topic's whole re-sequence. Measured on a copy of the
  Studio's real store and recovery file: 13,860 rows into 161 topics took
  12.5 s in total, with a yield between topics. The slowest single topic was
  7848 (12,638 rows), at 4.5 s. Re-sequencing only from the first restored
  row saves under 15% (topic 7848's recovered rows span nearly all of it), and
  splitting a topic's merge would let live readers see a half-rewritten
  conversation. Accepted for a deliberate, one-time repair: the response and
  audit report `slowestTopicMs` / `slowestTopicId`, and the operator runs it
  at a quiet moment.
- Summaries: `needsSummaryUpdate` compares row counts, so each imported
  topic reads as stale once and refreshes the next time it is summarized. The
  incremental read (`getMessagesSinceSummary`) is cursored by message id, so
  restored rows OLDER than an existing summary's cursor are not folded into
  that summary. Accepted: the summary existed before and still describes the
  conversation. The restored rows are reachable through search and the
  recent-history reads. Regenerating every affected summary from scratch would
  cost one large model call per topic, against the operator's standing
  preference for low token burn. A topic with no summary yet summarizes
  everything, restored rows included.
- Refusal samples name a type or reason only, never field content.
- A peer's carried copy of a restored message does not supersede it: the
  restored copy stays labelled `imported` with no authority until the local
  delivery or a rebuild from a log that holds the message. That errs safe.
  A Telegram entry with a non-positive id takes the legacy `insertMessage`
  path, which never supersedes; restored rows always have positive ids.
- The carrier receive path accepts a row a peer labels `imported`. Current
  peers never send one (their carrier skips restored rows). A row that does
  arrive is stored with the label, which only narrows authority.
- Unit: validator (each refusal reason, authority narrowing, timestamp
  normalization); merge ordering (interleaved, all-older, all-newer,
  out-of-order live rows preserved, equal timestamps); two-batch import ==
  one replay after rebuild; idempotence; FTS hit for an imported word;
  id-ordered readers (`lastMessageIdByRow`, `messagePrecedes`) answer by time
  after the merge; `classifyRow` labels an imported operator row `recovered`
  with no authority, and imported agent rows stay out of the corpus; a
  half-written temp batch is ignored by replay; live-after-import
  supersedes; retry heals a failed merge; the cumulative bound; rebuild and
  import serialize; re-apply continues past a failing topic.
- Integration: `POST /topic/import` over HTTP — file and rows modes, dryRun,
  path escape refused, device principal refused, audit line written, second
  call all-duplicate.
- E2E: the production init path (TopicMemory opened as server.ts does, routes
  mounted) answers 200, not 503, and `/topic/search` finds an imported row.
