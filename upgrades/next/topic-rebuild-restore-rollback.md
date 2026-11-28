# A history rebuild that cannot finish now keeps your messages instead of losing them

<!-- bump: patch -->

## What Changed

PROP-1646. `POST /topic/rebuild` deletes every row in the searchable message
store and then re-imports from the logs. Since #3123 it refuses to delete when
its pre-flight scan finds nothing a source could restore, and that scan is
trustworthy because it streams every line through `parseLogLine` — the same
admission predicate the importer uses. The predicate modelled the parser and not
the table: it required `entry.text` and a usable key, and never `timestamp`,
which `messages.timestamp` and `topic_meta.last_activity` both declare NOT NULL.
A logged line with text, a Slack channel and no timestamp was therefore counted
as restorable, the delete ran on the strength of that count, and the import then
threw `NOT NULL constraint failed: topic_meta.last_activity` with every row
already gone — leaving an empty store, a 500, and no rebuild report to read.

Two changes. `parseLogLine` now refuses a line whose `timestamp` is absent or
NULL, as `missing-fields`, so the pre-flight and the import agree again; nothing
is lost by refusing it, because no row of that shape was ever storable (the
batch path dropped it silently, the keyed path threw). And the delete is now
reversible for the length of the restore: the rows are held in a connection-local
TEMP copy, and a throw out of the import puts them back, reports
`restore-failed-rolled-back` with `deleted: 0`, logs the cause and re-raises the
original error. A hard crash mid-restore is still not covered, and the code says
so where someone would look.

## What to Tell Your User

- **A failed history rebuild no longer empties my memory**: "The maintenance
  command that rebuilds my message history from my logs could delete everything
  and then stop part-way through putting it back. Now if anything goes wrong, my
  messages are put back exactly as they were and I tell you the rebuild failed."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| A rebuild whose restore fails leaves the store as it was | Automatic |
| A logged line with no timestamp is counted as unusable rather than restorable | Automatic |
| `restore-failed-rolled-back` reported by `POST /topic/rebuild` | `getLastRebuildReport()` / the route's `refused` field |

## Evidence

- `tests/unit/topic-rebuild-aborted-restore.test.ts`: 9 cases, 6 of which fail on
  `68834ded8` and pass with the change (measured in a worktree detached at that
  commit, with the fix verified absent by reading `parseLogLine` there). Three fail there with the measured
  `SqliteError: NOT NULL constraint failed: topic_meta.last_activity`, raised at
  the `topic_meta` upsert and reaching `rebuildUnlocked` on the line after the
  two `DELETE`s; three fail on the store's contents (2 rows where 4 were
  expected, 0 where 1, 0 where 2). One case injects a mid-restore failure with no
  connection to the admission rule, so the rollback is pinned independently of
  the predicate fix. A CONTROL asserts the fixture passes the shipped §14 key
  rule and that no store holds it either way, so the suite cannot pass by the
  fixture being junk. A rolled-back store is asserted searchable again (the
  external-content FTS index is re-derived) and its summaries intact.
- `tsc --noEmit` exit 0, verified non-vacuously: a planted type error in
  `src/memory/TopicMemory.ts` is reported at its line with exit 1, then removed.
