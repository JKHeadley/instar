---
slug: topic-rebuild-restore-rollback
tier: 1
reviewer: self
date: 2026-11-21
---

# Side-Effects Review — a rebuild that cannot finish its restore keeps the rows

**Version / slug:** `topic-rebuild-restore-rollback`
**Date:** `2026-11-21`
**Author:** `Dawn (dawn-evolve-prop-1646)`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

`TopicMemory.rebuild()` deletes every message row and then re-imports from the
logs. Since #3123 it refuses to delete when its pre-flight scan
(`countRestorable`) finds nothing a source could restore, and the scan's
authority comes from streaming every line through `parseLogLine` — the SAME
predicate the importer uses — so its count is the number the import would land
in an empty store. This change closes a hole in that property and then stops
relying on the property alone.

The hole: `parseLogLine` modelled the PARSER, not the TABLE. It admitted a line
on `entry.text` plus a usable key and never looked at `timestamp`, which
`messages.timestamp` and `topic_meta.last_activity` both declare NOT NULL. A
Slack-keyed line with no `timestamp` was therefore counted as restorable, the
delete ran on the strength of that count, the `INSERT OR IGNORE` into `messages`
was absorbed by the constraint, and the `topic_meta` upsert inside
`insertMessage` threw `NOT NULL constraint failed: topic_meta.last_activity` out
of `importFromJsonl` — uncaught, with every row already gone. Reproduced on
`68834ded8` in `tests/unit/topic-rebuild-aborted-restore.test.ts`: the store
ends at 0 rows and `getLastRebuildReport()` is never set, so the caller cannot
even tell what happened.

Files touched: `src/memory/TopicMemory.ts` (the predicate, the report's reason
union, `rebuildUnlocked`, three new private snapshot helpers) and
`tests/unit/topic-rebuild-aborted-restore.test.ts` (new, 8 cases).

Two changes, because closing only the first would leave the destructive step
trusting that nothing else can ever throw:

1. **Admission agrees with the schema.** `parseLogLine` refuses a line whose
   `timestamp` is absent or NULL, as `missing-fields`. Still ONE predicate, so
   the pre-flight and the import cannot disagree.
2. **The delete is reversible for the length of the restore.** The rows are held
   in a TEMP copy; a throw out of `importAllLogs` puts them back, records
   `restore-failed-rolled-back`, logs the cause, and rethrows.

## Decision-point inventory

- `parseLogLine` (admission: is this logged line a row this store can hold?) —
  **modify** — now also requires the `timestamp` the schema requires NOT NULL.
  Mechanical, derived from the table's own constraints; no new judgment.
- `rebuild()` pre-flight (`existing > 0 && restorable === 0`: may this rebuild
  delete?) — **pass-through** — the rule is untouched. Its INPUT is now correct
  for the measured shape, which is the point.
- `rebuildUnlocked` (what happens when the restore fails?) — **add** — previously
  undefined behaviour (store empty, exception to the caller, no report); now a
  rollback plus a named reason.

---

## 1. Over-block

The one new refusal is a line whose `timestamp` is absent or NULL. The question
that matters is whether any such line could previously have become a row:
**none could.** On the batch (Telegram-keyed) path the `INSERT OR IGNORE` is
absorbed by the NOT NULL constraint and `result.changes` is 0 — the line was
already dropped, silently and uncounted. On the keyed (Slack) path the insert
threw. So the refusal removes nothing a store could ever have held; it only
stops the pre-flight from counting it. The CONTROL case in the new test asserts
exactly this: the fixture reaches a usable key under the shipped §14 rule, and
no store holds it afterwards either way.

Deliberately NOT over-blocked: only NULL and absent are refused, because NULL is
what the constraint refuses. `timestamp: ''` and `timestamp: 0` satisfy NOT NULL
and store today; widening the check to `!entry.timestamp` would silently stop
importing rows that currently import, which is a different change with a
different argument. The existing `!entry.text` check keeps its pre-existing
truthiness semantics, untouched (#3123 measured 29 real rows with `text: ''`
refused by it; that number does not move).

Rollback over-block: none. The rollback fires only on a thrown exception from
the restore, a path whose previous behaviour was an emptied store.

---

## 2. Under-block

- A line with a `timestamp` of the wrong SHAPE (`''`, `0`, `'not a date'`) is
  still admitted, counted and stored, as it is today. Ordering and
  `topic_meta.last_activity` are then garbage for that row. This change does not
  touch it, because the constraint does not.
- The pre-flight still cannot promise that a counted row will land for any
  reason OTHER than the NOT NULL columns — a collision, a key mismatch, a
  concurrent writer. That residual is exactly why change 2 exists: the guarantee
  is no longer "the count is always right" but "if the restore fails for any
  reason, the rows are back".
- A hard CRASH (not an exception) mid-restore is still unprotected: the TEMP copy
  dies with the connection and the store stays as the import left it. Stated in
  the code at the call site rather than implied. Covering it needs a durable copy
  plus a rule for a second process opening the store mid-rebuild — a decision
  this change deliberately does not make.
- A message older than its log's retention window is still lost by a rebuild.
  Unchanged, and already stated in `rebuild()`'s own contract.

---

## 3. Level-of-abstraction fit

Both halves sit at the layer that owns the fact they encode.

`parseLogLine` is the right home for change 1 because it is already the single
admission decision the code treats as load-bearing — its own comment says a
second copy "would let the scan promise a restore the import does not perform",
which is this defect arriving through ONE copy that was simply incomplete. The
alternative considered and rejected was containing the per-line write failure
inside `importFromJsonl` (catch, count, continue): that moves the knowledge of
the table's constraints into the writer, leaves the pre-flight count still
wrong, and re-adds the per-line containment one layer down that PROP-1289
retired. Fixing the predicate keeps one predicate.

`rebuildUnlocked` is the right home for change 2 because it is the only place
that knows a delete has happened and a restore is owed. Pushing the rollback
down into `importFromJsonl` would make a partial import look like a success;
pushing it up into the route would put SQL in the HTTP layer.

Not re-implemented: the restore uses SQLite's own copy and the existing
external-content FTS `'rebuild'` command, not a hand-rolled row loop.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface in the signal-vs-authority
      sense, and the one refusal it adds is an invariant, not a heuristic.

`parseLogLine`'s new condition is a mechanical read of the table's own NOT NULL
constraints: `timestamp == null` is not a guess about intent, it is the same
question SQLite asks a line later, asked early enough to be useful. There is no
threshold to tune and no input shape where a reasonable person would want the
other answer, because the other answer is an exception after a delete.

The pre-flight's authority to block a delete is unchanged — this change feeds it
a correct count rather than giving it new power. The rollback holds no authority
at all: it does not decide whether to proceed, it restores what was there and
rethrows the original error.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Both additions
are invariants over a single signal: a column the schema declares NOT NULL is
either present or it is not, and an exception either propagated out of the
restore or it did not. No two live signals can conflict here, so there is
nothing for an arbiter to weigh.

---

## 5. Interactions

- **Shadowing:** change 1 runs INSIDE the predicate both the pre-flight and the
  import call, so it cannot shadow one and not the other — that symmetry is the
  property being restored. The refused line now lands in the existing
  `missingFields` tally, which `importFromJsonl`'s end-of-import warning and the
  `/topic/rebuild` response's `parseErrors.missingFields` already surface; a line
  that used to vanish uncounted is now counted.
- **Double-fire:** the rollback can only run once per `rebuild()` call, and the
  `finally` drops the copy on both paths. `rebuild()` holds
  `withTopicHistoryLock`, so a concurrent `POST /topic/import` cannot interleave
  with the snapshot/delete/restore window. Nested `db.transaction` inside the
  restore is a SAVEPOINT (better-sqlite3), not a second top-level transaction.
- **Races:** the TEMP tables belong to this connection, so no other connection
  can read or clobber them. A live write landing on the same connection DURING
  the restore window (a Telegram message arriving mid-rebuild) is the one real
  interaction: the rollback's `DELETE FROM messages` would remove it along with
  the partial import. That row is in the log and replays; and on today's code it
  would be written into a store that is mid-delete anyway, so the change does not
  make it worse. Noted rather than hidden.
- **Feedback loops:** none. The rollback writes only into the store it read, and
  nothing consumes `restore-failed-rolled-back` to trigger another rebuild.
- **Corruption auto-recovery** (`open()` → `importFromJsonl` after deleting a
  corrupt db) is not on this path: it imports into a fresh empty store and never
  deletes rows it could not restore.

---

## 6. External surfaces

- **Other agents on the same machine:** none. Everything is inside one store's
  own connection.
- **Install base:** `POST /topic/rebuild` behaves differently in exactly two
  cases, both of which were broken before. (i) Logs holding only
  timestamp-less lines: it now answers `rebuilt: false`,
  `refused: "sources-hold-no-restorable-message"` with the rows intact, instead
  of 500-ing with the store emptied. (ii) A restore that throws: the route still
  answers 500 (the error is rethrown), but the store is intact and the next call
  to `getLastRebuildReport()` says `restore-failed-rolled-back` with
  `deleted: 0`. A successful rebuild's response is byte-identical to before.
- **External systems:** none. No network, no Telegram/Slack/GitHub surface.
- **Persistent state:** the `messages` and `topic_meta` tables, and only in the
  direction of keeping rows that are currently destroyed. The snapshot tables are
  TEMP, so no new persistent object and no schema version change. `topic_summaries`
  is untouched, as before.
- **Timing:** one extra copy of the pre-existing rows, on a rare, manual,
  destructive operation that already pays a full streaming pass over every log.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing
  action is added or changed. `POST /topic/rebuild` is an existing agent-token
  route; this change only makes its failure honest.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard renderer, markup file,
approval page, or grant/revoke/secret-drop form is staged or touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**, with the reason: `topic-memory.db` is one machine's
own store, rebuilt from that machine's own `*-messages.jsonl` logs in its own
state dir. There is no pool-wide copy of it to keep coherent, and a rebuild on
machine A says nothing about machine B's store — each machine's logs are the
authority for its own store. The rows this change preserves are the local rows.

- **User-facing notices:** none. The two new log lines are operator/agent-facing
  console output on an explicitly invoked operation, not a notice to a person, so
  no one-voice gating applies.
- **Durable state:** the snapshot is TEMP and cannot strand on a topic transfer
  or outlive the process. No durable state is added.
- **URLs:** none generated.
- **Status surfaces:** no new or changed `/status`, `/health`, `/capabilities` or
  `/channels` answer. `POST /topic/rebuild`'s existing body gains no field; the
  `refused` field it already carries can now hold one more reason string, which
  is per-machine by construction because the route acts on the local store.

---

## 8. Rollback cost

- **Hot-fix release:** pure code revert, ship as the next patch. Reverting
  restores the previous behaviour exactly, including the defect.
- **Data migration:** none. No column, table or schema version is added — the
  snapshot tables are TEMP and dropped in a `finally` on both paths.
- **Agent state repair:** none. A store that was rebuilt under this change is
  indistinguishable from one rebuilt before it, except that rows survive a failed
  restore. No agent needs notifying or resetting.
- **User visibility:** no regression during a rollback window. The change's only
  user-visible effects are a refusal where there was data loss and a preserved
  store where there was an empty one.

---

## Conclusion

The review changed one design decision and sharpened a second. The design
decision: the row (PROP-1646) offered three candidate fixes and argued for the
predicate fix alone as the one that preserves the single-predicate property. On
reading `rebuildUnlocked` I kept that fix AND added the rollback, because the
predicate fix closes the measured INSTANCE while leaving the destructive step
resting on "nothing else in the restore can ever throw" — a claim the pre-flight
cannot make and `importAllLogs` cannot honour. The two pin independently: the
new test injects a mid-restore failure unrelated to admission, so the rollback is
proved by a case change 1 does not touch. The sharpening: the refusal is scoped
to NULL and absent rather than falsy, so no row that currently stores stops
storing.

Clear to ship. Two residuals are named rather than filed away: a hard crash
mid-restore is still unprotected (it needs a durable copy and a two-process
rule), and a live write arriving on the same connection during the restore window
would be rolled back with the partial import.

---

## Second-pass review (if required)

**Reviewer:** not required — Tier 1 change (two files, ~90 source lines, no new
decision authority, no persistent state, no operator surface).
**Independent read of the artifact: [not applicable]**

---

## Framework generality

This routes through the framework's own existing primitives rather than adding a
parallel path: the admission fix lives in `parseLogLine`, the one shared
predicate both the scan and the import already call, and the restore uses
SQLite's own table copy plus the existing external-content FTS `'rebuild'`
command. No new abstraction is introduced, and nothing here is specific to one
agent, one channel or one deployment — the invariant it encodes ("a line that
cannot satisfy the table's NOT NULL columns is not restorable") is a property of
the schema every instar store shares. The rollback generalises in the same way:
it is keyed on "the restore threw", not on the particular SqliteError that was
measured, so a future column or a future channel's write failure gets the same
protection without another patch.

---

## Evidence pointers

- **Reproduction on unmodified `68834ded8`**, before the fix was written:
  `tests/unit/topic-rebuild-aborted-restore.test.ts` → 6 of 8 cases fail. Three
  fail with the row's measured error, `SqliteError: NOT NULL constraint failed:
  topic_meta.last_activity`, raised at `TopicMemory.insertMessage` (the
  `topic_meta` upsert) and reaching `rebuildUnlocked` at the line AFTER the two
  `DELETE`s. Three fail on the store's contents: 2 rows where 4 were expected
  (the partial import, originals gone), 0 where 1 was expected, 0 where 2 were
  expected.
- **After the fix:** 8/8 pass. `tsc --noEmit` exit 0 — verified non-vacuously by
  planting `const probeX: number = "definitely not a number";` in
  `src/memory/TopicMemory.ts` and confirming tsc reports TS2322 at that line and
  exits 1, then restoring the file byte-identically. A green typecheck that
  cannot see the file is not evidence.
- **The fixture is proved admissible, not junk:** the CONTROL case asserts the
  timestamp-less row carries `text` and that `topicMemoryKeyForLogEntry` returns
  `kind: 'slack'` for it — it passes the shipped §14 key rule — and that no store
  holds it afterwards regardless.
- **Reachability is UNKNOWN, not zero, and the row says so.** There is no instar
  `telegram-messages.jsonl` or `slack-messages.jsonl` on this machine to count
  real lines of this shape against, so the measurement is of the code path, not
  of a live log's contents. What is established: nothing between a log line and
  the store rejects the shape, and the pre-flight counts it as restorable.

---

## Class-Closure Declaration (display-only mirror)

No `unbounded-self-action` class is introduced: nothing here is self-triggered.
`rebuild()` runs when an operator calls `POST /topic/rebuild`; the rollback runs
only inside that call, once, on a thrown exception, and takes no action on the
world beyond restoring rows into the store it just read. No loop, no monitor, no
respawn, no notify, no retry — in particular the rollback does NOT re-attempt the
rebuild, so there is no control loop to bound.

Not a defect in an agent-authored prompt, hook, config, skill or standards text:
the defect is in TypeScript source, so the class-closure gate's artifact classes
do not apply and the trace's machine-readable `classClosure` is null.

Defect class this closes: **a destructive step authorised by a pre-flight whose
predicate models a different gate than the one that will actually refuse the
write.** Closed on both axes — the predicate now reads the table's own
constraints, so the pre-flight and the import agree; and the delete is reversible
for the length of the restore, so a disagreement from any other cause costs an
error message instead of a store.
