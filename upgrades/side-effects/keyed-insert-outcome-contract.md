# Side-Effects Review — the keyed row-insert outcome contract

**Slug**: `keyed-insert-outcome-contract`
**Branch**: `dawn/prop-1289-keyed-insert-outcome`, cut from `upstream/main` `644224d89`
**Tier declared**: 1 (signal: suggestedTier 2, sizeTier 2, riskFloor 1)
**Provenance**: the-portal PROP-1289, open since 2026-10-08. The layer decision is
recorded in `.claude/artifacts/prop-1289/UPSTREAM-DRIFT-DECISION-20261115.md` in that
repo; this change is steps 1–3 of the shape it prescribes.

## Summary of the change

`TopicMemory.insertKeyedMessage` returned `{ outcome: 'inserted' }` without reading
whether a row landed. It calls `insertMessage`, which writes with `INSERT OR IGNORE`
and returned `void`. `OR IGNORE` absorbs every constraint the keyed pre-checks cannot
see — NOT NULL, CHECK — writing zero rows and raising no error, which from the caller
is indistinguishable from success.

Measured on `644224d89` with the real schema and better-sqlite3, before this change
(`tests/unit/topic-memory-keyed-insert-outcome.test.ts` reproduces it):

```
insertKeyedMessage({ …, text: null })
  -> { outcome: 'inserted' }
  -> rows in `messages`: 0
  -> topic_meta.message_count: 1
```

Three edits carry the truth upward:

1. `insertMessage` returns whether a NEW row landed (`changes > 0`). It catches
   nothing: every throw that happens today still happens.
2. `insertKeyedMessage` returns a new outcome, `'not-landed'`, instead of `'inserted'`.
3. The two counting consumers map it — `TopicRowWriter.writeRow` as a counted refusal
   beside `collision` and `key-mismatch`, `importFromJsonl` as a `notLanded` tally —
   and the tally reaches both of its readers (the end-of-import warn line and
   `POST /topic/rebuild`'s `parseErrors`).

## Decision-point inventory

| decision | where | who decides now |
|---|---|---|
| did a row land? | `insertMessage` | the database (`changes`), where it was previously assumed |
| what to report upward | `insertKeyedMessage` | the insert's own answer |
| what a not-landed row means for a channel write | `TopicRowWriter.writeRow` | the writer: a counted refusal + a degradation report |
| what it means for an import | `importFromJsonl` | a separate counter, never `imported` |

## 1. Over-block

None. Nothing new refuses, retries, or waits. `writeRow` answers `written: false` for a
row that is NOT in the database — a state that previously reported `written: true`. The
only behavioural question is what existing callers do with that, which is §5.

## 2. Under-block

The silent class this closes is reported, not prevented: the row still does not land.
That is correct at this layer — `insertKeyedMessage` cannot know why the store refused,
and guessing a repair here is the design that was retired (see §4).

Reachability, stated rather than implied: on today's admission rules no JSONL line
produces this outcome, because `parseLogLine` rejects a line with falsy `text` and a
missing `timestamp` throws at the `topic_meta` upsert instead. The silent class is
reachable through the direct keyed callers, whose bodies come from channel adapters
rather than from the admission-checked parser. The contract is fixed regardless of
which input shapes reach it today: the admission checks are a different layer, and the
`notLanded` counter is what makes a future change to them visible instead of silent.

## 3. Level-of-abstraction fit

The fix sits at the layer that already owns this vocabulary. `insertKeyedMessage`'s
docstring is the contract being honoured: *"Unlike `insertMessage`, this never ignores
silently … so the caller can count it."* `collision` and `key-mismatch` are already
refusals it returns rather than throws; `not-landed` is the third member of that set.
Five earlier attempts at this item aimed a `try`/`catch` at `insertMessage`, one layer
BELOW the untruthful return.

## 4. Signal vs authority compliance

The database is the authority on whether a row landed, and this change is precisely a
move from an assumed answer to the measured one. Nothing here decides on the store's
behalf. The rejected alternative — catching the failure inside `insertMessage` — would
have made this code the authority on an outcome it cannot observe.

## 4b. Judgment-point check

One judgment was made and is recorded rather than buried: the `topic_meta` upsert is
left unchanged, including that it runs for a row that did not land (see §9). The
alternative, skipping it, removes a throw that exists today — which is containment by
omission, the exact failure mode this item retired.

## 5. Interactions

- `topicRowCarrier.ts:495` — `r.written ? {…} : null`. A not-landed row now returns
  `null`, the same path `collision` and `key-mismatch` already take, which is the
  truthful answer for a row that is not stored. No new branch needed.
- `topicRowWriter.ts:463` (`reconcileAppConversationRows`) — `else if ('refused' in r)
  out.refused++`. Counted automatically, no edit.
- `server.ts:10276` — ignores the result today and still does.
- `server.ts:10278` — the legacy `insertMessage` call for a non-positive-integer
  Telegram id ignores the new return value; `void` → `boolean` is source-compatible.
- `importAllLogs` sums `notLanded` across sources, so a multi-source rebuild does not
  drop the count of the files after the first.

## 6. External surfaces

One additive field: `POST /topic/rebuild` → `parseErrors.notLanded`. No new route, no
config key, no schema or migration, no auth, token or secret surface, no self-triggered
controller. The SQLite schema is untouched.

## 6c. Observability — and what SILENCE means here

Before: silence meant nothing, because a dropped row was reported as `inserted` and no
counter anywhere moved. After, silence means a real zero on three independent surfaces:
`TopicRowWriter.stats().<channel>.refused['not-landed']`, the `notLanded` import tally,
and a `DegradationReporter` row naming the channel message id that is missing. The
refusal detail names the message, so the report identifies a row rather than a rate.

The counter has readers, which is the point: the end-of-import `console.warn` line now
includes `not_landed` AND fires on it (its condition was extended — a counter that
cannot trip its own warning is not a report), and the rebuild route carries the field.

## 6b. Operator-surface quality

The degradation report reuses the writer's existing `TopicRowWriter.<channel>` feature
name and refusal shape, so an operator reading it sees the same structure they already
know from a collision, with a detail line naming the message and the key.

## 7. Multi-machine posture

None. This is a per-machine local store; the key rule it reports on is unchanged, and
nothing about the derived keys, their determinism, or cross-machine layer references
moves. A machine that takes this change and one that has not derive identical keys and
store identical rows; they differ only in whether a row that did not land is counted.

## 8. Rollback cost

A revert fully undoes it. No data is written differently, no migration runs, no file
format changes. The only artefact that outlives a revert is a `parseErrors.notLanded`
field in a JSON response, which an older client already ignores.

## 9. Recorded, deliberately not changed

`insertMessage` still runs the `topic_meta` upsert for a row that did not land, so
`getTopicMeta().messageCount` and `getMessageCount()` disagree by one (measured above:
1 versus 0). Left alone on purpose, for two reasons that are both checkable: that
upsert is where a null timestamp throws today, and `rebuildTopicMeta()` recomputes the
count from the `messages` table on every import and rebuild, which is the repo's own
definition of that number. A test pins the divergence so the next person finds a
record rather than a surprise.

## Conclusion

Tier 1. The change replaces an assumed receipt with a measured one, in a method whose
own documentation already promised the measured one, and routes the new state into the
refusal vocabulary the same file already has. 25 of the 64 added source lines are code;
the rest are comments. The risk floor computed by the classifier is 1 — no safety
invariant, irreversibility, fleet-rollout or new-capability signal fires — and the size
tier is 2 only because the total line count, comments included, passes 40.

## Second-pass review

Not required (Tier 1).

## Evidence pointers

- `tests/unit/topic-memory-keyed-insert-outcome.test.ts` — 9 tests, each carrying its
  positive control in the same test: the founding case at the store; the pre-checked
  outcomes unchanged; `insertMessage`'s own answer; the writer's refusal, counter and
  report; the import tally; a direct read of the database proving the row is absent;
  the recorded `topic_meta` divergence; an AST ratchet that neither method catches
  anything, with a control proving the detector can say CAUGHT and that `try`/`finally`
  is not containment; and a seam test that an operational failure still escapes rather
  than becoming an outcome.
- `tests/integration/topic-memory-routes.test.ts` — one assertion that the counter
  reaches the rebuild route.
- `tsc --noEmit` exit 0. All 54 lint steps pass.
- Mutation sweep: recorded in the commit and in the PROP row.
