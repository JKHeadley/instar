---
slug: slack-jsonl-import
tier: 1
reviewer: self
date: 2026-11-12
---

# Side-Effects Review — Slack JSONL import, and a rebuild that no longer erases Slack history

## Summary of the change

`TopicMemory.importFromJsonl` admits a logged message only when it carries
`entry.topicId`. Slack's logger writes `channelId` and never `topicId`, so every
line of `slack-messages.jsonl` fails admission and is counted as
`missing_fields`. One gap, two consequences, both measured on live stores:

1. Slack history is **unreplayable** — the log is intact with real `ts` values
   and nothing can read it. Measured 2026-11-12 on copies of two agent stores:
   671 importable Slack messages present in the logs and absent from the
   databases (263 of sagemind's 278 rows, 408 of indra-instar's 425; the other
   29 carry `text: ''`).
2. Slack history is **destroyable** — `rebuild()` deletes every row and then
   imports from `telegram-messages.jsonl` alone, so it destroys every Slack row
   and restores none. On an agent with no Telegram log it empties the store and
   returns success.

PR #3044 (merged 2026-11-11) fixed the LIVE write through `writeSlackLogRow` and
the §14 key rule. It did not touch the import. This is that half.

The change: (a) `topicMemoryKeyForLogEntry`, one shared admission function that
derives a Slack entry's key by CALLING `deriveRowKey` — the shipped §14 rule —
and its topic through `candidateIdForRoutingKey`; (b) Slack rows go in through
`insertKeyedMessage` so a clash is a counted refusal rather than a silent
`INSERT OR IGNORE` drop; (c) `rebuild()` replays every log beside the one it was
handed and refuses to delete when nothing it can read could restore what is
there; (d) `importAllLogs()`, non-destructive and idempotent, wired into server
startup — that is the backfill, reachable rather than library-only.

## Decision-point inventory

| # | Decision | Where | Authority |
|---|----------|-------|-----------|
| 1 | Is this logged line a row this store can hold? | `parseLogLine` → `topicMemoryKeyForLogEntry` | mechanical, derived |
| 2 | Which integer key and channel id does a Slack entry get? | `deriveRowKey` (topicRowWriter, §14) | the shipped rule, called not copied |
| 3 | Which `topic_id` does a Slack channel map to? | `candidateIdForRoutingKey` (governed) | mechanical, pinned to the live path |
| 4 | May this rebuild delete? | `rebuild()` pre-flight: `existing > 0 && restorable === 0` | mechanical, relative rule |
| 5 | Which logs does a rebuild read? | `replayableLogs()` | mechanical, directory-derived |

No judgment point and no LLM call is introduced. Every decision is a pure
function of the log's own bytes and the store's own row count.

## 1. Over-block

The only new refusal path is decision 4, bounded by a relative rule rather than a
threshold: it fires only when the store holds rows AND the sources hold **zero**
restorable rows. A rebuild that can restore even one row proceeds and deletes,
exactly as before. There is no number to tune and no way for the guard to
over-fire as data grows — the only case it blocks is the case where the operation
is provably pure loss.

Residual over-block, named: an operator who genuinely wants an empty store
(rather than a rebuild) now deletes the database file instead of rebuilding
against a missing log. That is the right place for that intent, and the refusal
message says what it looked for rather than only refusing.

Decision 1 also refuses a Slack entry the key rule returns an error for. That
stores strictly fewer rows than storing them under 0 would — but two rows under 0
keep one and drop the other, which is the original defect reproduced inside the
recovery path. A counted refusal beats a silent collision. Measured on real data:
0 refusals across 703 log rows.

## 2. Under-block

The guard does not refuse a **partial** source — a rebuild whose logs cover only
some of the store still deletes the rest. That is deliberate, documented in the
method's own comment, and pinned by a test (`still deletes on a partial source,
and reports the shortfall rather than hiding it`): the destructive contract is
the caller's to invoke, and `topic-memory.test.ts` → `rebuild > clears existing
messages and reimports` asserts exactly that behaviour. Changing it is a
different decision from this one and the maintainer's, not mine.

What changed instead is that the loss stopped being silent: `deleted` and
`restored` are both reported through `getLastRebuildReport()`, a shortfall is
logged with its cause, and `POST /topic/rebuild` stops answering `rebuilt: true`
after a wipe.

## 3. Level-of-abstraction fit

The admission decision lives in `TopicMemory`, next to the INSERT it governs, as
one module-level function used by both the importer and the pre-flight scan.
Neither derivation is reimplemented:

- `deriveRowKey` from `topicRowWriter` gives `message_id` and
  `channel_message_id`. Re-deriving "ts × 1e6" here would agree with the rule on
  every ordinary message and disagree on exactly the case the rule handles
  specially — a Slack id that is not a `ts` (a standalone file share), which the
  rule puts in the fallback range above 2^52. That divergence is what a second
  copy always produces, and a recovered message under a key the live path would
  never produce is a message in the wrong place. A mutant that re-derives the
  key locally is killed by two tests.
- `candidateIdForRoutingKey` gives `topic_id`. `topicRowCarrier`'s
  `slackSyntheticTopicId` is the same call with a Slack-specific name and would
  read better, but `topicRowCarrier` imports a VALUE from `TopicMemory`
  (`coerceTopicRowOrigin`), so importing it here would be a runtime cycle. The
  equivalence is stated in that module's own doc comment and the reason for not
  using it is recorded at the call site.

One new import edge, `src/memory/TopicMemory.ts` → `src/memory/topicRowWriter.ts`.
It is safe in the direction that matters: `topicRowWriter` imports `TopicMemory`
with `import type` only, which tsc erases, so no runtime cycle is created. Both
files are in the same directory and there is no layering lint in the repo.

The channel-only routing key is a deliberate choice with a control: `threadTs`
exists on the log entry and `routingKeyForTuple` would fold it in, but the live
dual-write hashes `channelId` alone, so a thread-aware key would split a thread's
history away from the live rows. The test asserts the channel-only key AND that
the thread-aware key is a different number, so it pins a choice rather than
restating an identity.

## 4. Signal vs authority compliance

`rebuild()` keeps its authority — it still deletes when it has a source. The new
refusal is not the code overriding the operator's intent; it is the code
declining an operation that is definitionally impossible (restore from nothing).
The report object is signal: counts, sources and a reason, for the caller to read.

Using `insertKeyedMessage` for Slack rows is the §14 rule's own requirement that
a key held by a different channel message be a COUNTED refusal and never a silent
drop. The batched `INSERT OR IGNORE` cannot distinguish a replay from a clash,
which is the shape that hid the original defect; this import reports
`duplicate`, `adopted`, `collision` and `keyMismatch` separately.

## 4b. Judgment-point check (Judgment Within Floors standard)

There is no judgment point in this change. Every branch is a pure function of
bytes already on disk, with no LLM call, no heuristic and no tunable threshold.
Decision 4 is a relative rule (`restorable === 0`), the shape that needs no
ruling and cannot drift with data volume.

## 5. Interactions

- **PR #3044** owns the live write; this owns the replay. They now share both
  derivations, so an imported row and a live row for the same message are the
  same row. Verified by a test that writes rows with the production
  `writeSlackLogRow` and then imports the log: zero rows added, seven counted as
  `duplicate`.
- **`getLastImportStats()`** returns the named `TopicImportStats` and gains
  `unkeyed`, `duplicate`, `adopted`, `collision`, `keyMismatch`. Additive — the
  one production consumer (`/topic/rebuild`) and the test consumer both read
  fields by name.
- **`importAllLogs()` accumulates stats across sources.** Calling
  `importFromJsonl` N times would otherwise leave `_lastImportStats` holding only
  the last file's counters.
- **`rebuildTopicMeta()`** now runs once per source instead of once. It is an
  idempotent recompute from the messages table; the last run is authoritative.
- **Server startup** imports every log instead of the Telegram log only. The
  first start after this lands recovers the agent's Slack history (671 rows
  across the two agents here); every later one lands nothing.
- **FTS and summaries** behave as before: summaries are untouched by rebuild
  (test), and the FTS index is rebuilt by the same statement.
- **Ordering**: the keyed path flushes the pending batch first, so a batched row
  and a keyed row written in log order stay in log order if they ever share a
  topic. In practice they never do — Slack topics are negative, Telegram's
  positive.
- **Performance**: a Slack row costs one small transaction instead of a slot in
  a 500-row batch. Slack logs are bounded by `MessageLogger` (maxLines 100k) and
  are 101 KB and 304 KB on this machine; the Telegram log, which is 34 MB here,
  keeps the batched path untouched. `rebuild()` adds one extra streaming pass
  over its sources for the pre-flight, on a rare manual operation.

## 6. External surfaces

No network call, no API payload, no Slack API contract touched, and **no new
route**. `POST /topic/rebuild`'s response gains `refused`, `sources`, `deleted`,
`restored`, and three more `parseErrors` counters, and its `rebuilt` field stops
being the constant `true` — a client that read `rebuilt` as "did it work" now
gets a correct answer where it previously got `true` after a wipe. Fields are
added to an existing response and one constant becomes correct; no field is
removed or retyped.

An on-demand `POST /topic/import` was in an earlier draft of this work and is
deliberately left out: adding a route is a capability decision for the
maintainer, and its risk floor is honestly 2. The recovery does not depend on it,
because `importAllLogs()` runs at startup.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

`POST /topic/rebuild` is an operator surface, and the question this standard asks
— does the operator get enough to act on? — is what the old response failed.
`rebuilt: true` after deleting every row and restoring none told the operator the
opposite of what happened.

The answer in writing: a rebuild now returns what it read (`sources`), what it
destroyed (`deleted`), what it put back (`restored`), whether it declined
(`refused`, naming which of the two causes), and the parse counters including
refusals and key clashes. The refusal path logs a line naming the sources it
looked at and telling the operator to check where the store is looking — a
refusal that does not say what it looked for is a dead end. The non-destructive
recovery needs no operator action at all: it runs at startup and logs its
per-source counts, so "nothing was imported" is distinguishable from "nothing was
imported from the log you care about". No raw input is required, and the safe
path is the default rather than a power-user path.

## 7. Multi-machine posture (Cross-Machine Coherence)

Every path here is local to one agent home: it reads that home's own logs and
writes that home's own SQLite file. Nothing replicates, nothing is fetched from a
peer, and no shared state is written. Two machines running this concurrently
cannot interfere, because neither touches the other's state dir.

Both derived values are machine-independent by design, which is the §14
requirement: `deriveRowKey` is pure, and `candidateIdForRoutingKey` is the frozen
32-bit sum-shift hash. So the same Slack message imported on two machines lands
on the same `(message_id, topic_id)` with the same `channel_message_id` — the
property the layer references and the row carrier depend on.

## 8. Rollback cost

Low and non-destructive. The code change is revertible in one commit. The data
change is additive: reverting leaves the recovered rows in place (real messages
with correct keys, topics and channel ids), and a reverted importer simply stops
reading Slack entries again. Nothing is deleted on the way in, so there is no
state to unwind. The one behaviour a revert restores is the silent wipe, which is
the reason not to.

## Conclusion

Tier 1 is honest for this change, and the question the follow-up row asked —
"this deletes and restores rows, is tier 1 honest?" — deserves an answer rather
than a declaration. It introduces **no new DELETE**: the two `DELETE FROM`
statements in `rebuild()` are the ones already there, unchanged, now guarded by a
pre-flight that can only reduce the cases in which they run. The destructive
surface is narrowed, not widened, and the net effect on data is additive
recovery. No new route, no new authority, no judgment point, no external
contract, no cross-machine state. The precommit's own risk signal reads floor 1
for the staged diff.

## Second-pass review (if required)

Not required (tier 1, no authority change). The maintainer (Echo) asked for this
shape explicitly on Threadline thread-c0a32f35 — rebased onto main rather than
stacked, keyed from main's row-writer rule rather than the superseded helper,
with the two checks below — and will run the independent verification.

## Evidence pointers

- `tests/unit/slack-jsonl-import.test.ts` — 19 assertions against the real
  `TopicMemory`, with a fixture carrying the exact field set a live
  slack-messages.jsonl has.
- **Two controls, so a pass cannot be vacuous.** `admittedByUnfixedImporter`
  reproduces main's current admission test and asserts it reads 0 of the 7 Slack
  fixture rows while still reading 2 of 2 Telegram rows. The thread-key test
  asserts the thread-aware key is a different number before pinning the
  channel-only one.
- **The maintainer's two requested checks, both present and both load-bearing.**
  (a) A store whose rows were written by the production `writeSlackLogRow` takes
  zero rows from an import of the same log, with all seven counted `duplicate`.
  (b) A non-`ts` Slack id (a file share) gets the identical `message_id`,
  `channel_message_id` and `topic_id` on import as on the live write, in the
  fallback range above 2^52.
- **Mutation sweep, 9 mutants, 9 killed**, each by a distinct relevant test:
  Slack entries never admitted (17 failures); raw `channelId` as `topic_id` (17);
  thread-aware routing key (7); the key re-derived locally instead of through
  `deriveRowKey` (2 — the key-rule test and the non-`ts` parity test); the batched
  `INSERT OR IGNORE` used for Slack instead of the keyed insert (3, including
  check (a)); `channel_message_id` not kept verbatim (3); rebuild reading only
  the log it was given (7); the refusal removed (2); refusals not counted (1).
  `TopicMemory.ts` restored byte-identical afterwards.
- **Real-data measurement, on COPIES, never the live stores.** sagemind: 278 log
  rows over 5 channels → 263 imported, 15 `missing_fields`, 0 `unkeyed`, 0
  `collision`, 0 `keyMismatch`, and **0 new topics created** — the rows land under
  the five negative `topic_id` values already in that store (3→28, 9→125, 2→29,
  2→51, 4→50), which is the proof the mapping matches the live write path. A
  reimport inserted 0 and counted 263 `duplicate`. indra-instar: 425 rows over 9
  channels → 408 imported into an empty store, with **3 `duplicate` on the first
  pass**, which is the keyed insert surfacing that the log itself holds three
  repeated entries — a fact the old `INSERT OR IGNORE` path could not have
  reported.
- **Baseline before the change**, so no failure is misattributed: 191/191 across
  5 suites on unmodified main. After: 260/260 across 11 suites, including
  `topic-row-writer`, `topic-row-carrier`, the conversation-identity mint-idiom
  ratchet and the write-domain conformance ratchet. `tsc --noEmit` exit 0 with no
  output. All 51 lint steps pass.
- **Residuals measured rather than assumed, both named in the ELI16 and the
  release note.** (1) The 29 refused real rows all carry `text: ''` and are
  refused by the pre-existing text requirement this change does not alter.
  (2) A store that ran before #3044 still holds one row per channel under
  `message_id = 0` with a NULL `channel_message_id` (sagemind: 5 of its 20
  Slack-range rows). The import restores the same message under its real key
  without removing the legacy row, so that message can appear twice — measured as
  **2 of the 5**, not 5, because the other 3 are outside the log's retention
  window. Clearing the legacy zero-keyed rows is a deletion against live data and
  is left to the maintainer.
- **The fallback key range is covered by the fixture, not by the real data**: 0 of
  the 703 real log rows carry a non-`ts` id. Stated so nobody reads the real-data
  pass as covering it.

## Class-Closure Declaration (display-only mirror)

No `unbounded-self-action` class is introduced: this change takes no action on
the world. Every write is into the agent's own local store, from the agent's own
local log, triggered by an operator route or by startup. There is no outbound
effect, no scheduling, no spawning and no self-modification.

Defect class closed: **a replay path that cannot read one of the logs it
replays** — closed by a single shared admission function that the pre-flight scan
and the import are both required to use, so a future channel whose entries key
differently fails in one place rather than being silently skipped.
