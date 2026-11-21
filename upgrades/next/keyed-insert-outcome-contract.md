# A conversation row that was never stored no longer reports itself as stored

## What Changed

`TopicMemory.insertKeyedMessage` is the single keyed write every channel's message rows go
through (`TopicRowWriter.writeRow` → `insertKeyedMessage` → SQLite). It returned
`{ outcome: 'inserted' }` without ever reading whether a row landed. The write underneath it,
`insertMessage`, uses `INSERT OR IGNORE` and returned `void`; `OR IGNORE` absorbs every
constraint the keyed pre-checks cannot see — NOT NULL, CHECK — writing zero rows and raising
no error. From the caller, a dropped row and a stored row looked the same.

Measured on `644224d89` with the real schema and better-sqlite3: a keyed insert whose text is
missing answered `inserted`, left **zero** rows in `messages`, and still counted one in
`topic_meta`. Both consumers believed that receipt — `writeRow` answered `written: true` and
bumped `inserted`, and `importFromJsonl` bumped `imported`, which is the number
`POST /topic/rebuild` reports back as messages restored. So a row that is not in the database
could be reported as stored, in a store whose own docstring promises it "never ignores
silently … so the caller can count it".

The write now reads the database's own answer. `insertMessage` returns whether a NEW row
landed; `insertKeyedMessage` reports `not-landed` rather than `inserted`; `writeRow` makes it
a counted refusal beside `collision` and `key-mismatch`, with a `DegradationReporter` row
naming the channel message that is missing; and `importFromJsonl` counts `notLanded`
separately from `imported`, where the end-of-import warning line and the `/topic/rebuild`
response can both read it.

Nothing is caught. An unwritable or corrupt store still throws exactly as it does today — a
loud failure must not become a counted success, which is why an earlier containment patch for
this item was retired rather than shipped.

## What to Tell Your User

Nothing changes in normal use. If the conversation store ever refuses a row, the count of
stored messages no longer includes it, and the refusal is named on the degradation surface
and in the rebuild response instead of passing as a successful write.

## Summary of New Capabilities

- `KeyedInsertResult` gains `not-landed`; `RowRefusal` gains `not-landed`.
- `TopicImportStats` gains `notLanded`, surfaced in the end-of-import warning and in
  `POST /topic/rebuild` → `parseErrors.notLanded`.
- `TopicMemory.insertMessage` returns `boolean` (did a new row land) instead of `void`.
- The import's outcome switch gained an exhaustiveness check, so a future outcome cannot
  vanish from the tally.

## Evidence

9 new tests in `tests/unit/topic-memory-keyed-insert-outcome.test.ts`, each carrying its
positive control in the same test, plus two ratchets: an AST check that neither method catches
anything (with controls proving the detector can say CAUGHT and that `try`/`finally` is not
containment), and a seam test that an operational failure still escapes instead of becoming a
counted outcome. One assertion on `POST /topic/rebuild` that the counter reaches the route.
`tsc --noEmit` exit 0; all 54 lint steps pass.

One thing is deliberately unchanged and recorded in a test rather than left to be
rediscovered: `topic_meta.message_count` is still incremented for a row that did not land, so
two readings of the same store differ by one. `rebuildTopicMeta()` recomputes that count from
the messages table on every import and rebuild, and the line that would fix it is also where a
null timestamp throws today, so it is its own decision with its own evidence.
