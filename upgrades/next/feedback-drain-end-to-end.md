# Feedback drain: a full pass completes on real data

## What Changed

The operated feedback drain failed every run with `source record checksum conflicts with
its projection`. The canonical `feedback.jsonl` is an append-only, last-write-wins log:
when processing flips a report from unprocessed to processing it re-appends the report's
full row with the same `sourceRecordId`. The drain read its own re-append as a conflict,
and one conflict failed the whole run, so 742 clusters never left `collecting`.

- The processing writer now appends each update as a new source record (fresh
  `sourceRecordId`), as the spec requires. The 1,000 lines the old writer appended under the
  original ids are accepted as superseded versions only because they change `status` and
  `clusterId` alone. Any other same-id change, or an id bound to another report, is
  corruption: that line alone is held in `source_conflicts` (audited, integrity hold set), the
  cursor moves on, and every run ends `degraded` with `source-record-quarantined` until an
  operator repairs it.
- Self-heal: the conflict the earlier build recorded for a legacy update line is cleared
  (audited) when the cursor re-reads that line.
- Compaction: the cursor now starts after the checksum-verified copied prefix of a new
  generation instead of re-reading the whole corpus, and an already-compact generation
  is no longer copied into a byte-identical new file every interval.
- A projected batch replayed after a crash mid-pass no longer clusters (and counts) a
  report the store already processed.
- The `feedback-factory-process` job body is now one fixed script. The runner model used to
  improvise a zsh loop (`status=$(...)` fails: `status` is read-only in zsh), and a degraded
  run was recorded as a success. The script fails the job run (via
  `$INSTAR_JOB_FAILURE_FILE`) on a refused tick and on a `degraded`, `failed` or
  `abandoned` run, with the drain's reason. A tick proxied to the owner machine finishes at
  once (its outcome lives in the owner's run history and status).

Existing stores heal on the next run. The job body reaches existing agents through the
normal built-in job refresh on update. No operator action.

## What to Tell Your User

The feedback sorter was stuck: it tripped over its own bookkeeping on every run, so no
feedback reached the task list. It now runs end to end on the real backlog, and if a run
goes wrong the scheduled job says so instead of reporting success. Nothing for you to do.

## Summary of New Capabilities

- The feedback drain completes full passes on the live store (reports processed, clusters judged, ready work handed to Initiative tasks).
- One bad source record is quarantined instead of stopping every run.
- The drain job fails honestly when a run is degraded or refused.
