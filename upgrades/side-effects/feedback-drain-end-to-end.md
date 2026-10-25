# Side-Effects Review — feedback drain: a full pass completes on real data

**Version / slug:** `feedback-drain-end-to-end`
**Date:** `2026-10-01`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Seventh first-run blocker on the operated drain (Mac Studio). After authority generation 2
went active (epoch 22681), both runs (15:58 and 16:00 PDT) failed with `source record
checksum conflicts with its projection`; `source_conflicts` held one row
(`feedback-source:7720c778-…`, report `fb-1145e5c3-4a2`). Per the standing "three failed
rounds → structural review" rule, this change drove the REAL drain code against a copy of
the live store until a full pass completed, fixing every blocker met on the way:

1. **Root cause (checksum conflict) — the writer.** The spec (§5, source discovery) says a
   later last-write-wins update is a NEW source record with its own projection sequence, and a
   duplicate `sourceRecordId` with different bytes is corruption that holds. The processing
   writer broke the first half: `JsonlFeedbackStore.markProcessed` re-appended each processed
   report under its ORIGINAL `sourceRecordId`. The first live runs appended 1,000 such lines;
   the cursor then reached the first one (byte 2,992,509) and the drain, correctly by the
   spec's second half, called it corruption, and threw for the whole run. Fix: the processing
   update is appended without the old id, so `FeedbackSourceGenerations.append` mints a fresh
   one. Updates are now projected as their own records; clustering ignores them (only
   `unprocessed` rows are clustered).
2. **Legacy lines and quarantine.** The 1,000 lines already on disk keep their reused ids. A
   same-id line is accepted as a superseded version only when it differs from the projected
   record in the LWW fields alone (`status`, `clusterId`) — exactly what the old writer
   produced (all 1,000 live lines pass; 0 quarantined on the copy). Any other difference
   (`source-record-content-conflict`) or the id bound to another report
   (`source-record-identity-conflict`) is corruption: that line alone is held in
   `source_conflicts` with an audit row and `source_integrity_hold`, the cursor moves on, and
   EVERY run ends `degraded` / `source-record-quarantined` until an operator repairs the
   held line (spec §207: a persistent mismatch raises operator attention). One record no
   longer fails the whole run. **Self-heal:** when the cursor re-reads a legacy LWW line that
   the earlier build recorded as `source-record-checksum-conflict`, that row is deleted with
   an audit entry (`cleared-misclassified-conflict`); the hold is lifted only if it is a
   `source-record-*` hold and no conflict of any kind remains. The live store heals on its
   next run.
3. **Compaction re-read (found on the copy).** `acceptSourceHandoff` reset the cursor to
   byte 0 of the new generation, so every compaction re-read the whole corpus at 500 rows
   per run. It now takes the handoff's `startOffset` (the end of the copied prefix, already
   checksum-verified by `readManifest`). Optional parameter; callers without it keep 0.
4. **Byte-identical generations (found on the copy).** `compact()` on a generation with
   nothing superseded wrote a new 3 MB copy each interval (5 identical files in the replay).
   It now returns null when a manifest already exists and the output equals the input; the
   legacy file still always moves to a generation. The service restarts the compaction
   interval either way.
5. **Replay double-count.** A projected batch replayed after a crash mid-pass (process
   killed between clustering and `acknowledgeProcessedProjection`) re-clustered reports the
   store already marked processing, inflating `reportCount`; with updates now projected, the
   same batch could also hold a report and its update ("duplicated id" throw, every run).
   `withProjectedFeedbackScope` skips a row unless both the row and the store's folded state
   are `unprocessed`, before the duplicate check.
6. **Job honesty.** The `feedback-factory-process` body is now one fixed python script the
   haiku runner executes verbatim. The live run (transcript 8e49dd8d, 11:00 PDT) improvised
   `status=$(curl …)` in zsh (read-only variable), and the old body also accepted a
   `degraded` run as success. The script writes `$INSTAR_JOB_FAILURE_FILE` on: posture
   `unavailable`; unreadable status on a development agent; any tick response other than 202
   (e.g. 403 after an authority demotion); terminal `degraded` / `failed` / `abandoned`; and
   simulation work counts that advance. `dark` exits silently. A tick proxied to the owner
   machine finishes at once (its outcome lives in the owner's run history). Still in flight
   at 60 s is not a failure. Worst case ~93 s (10 s per HTTP call), inside the
   `timeout: 300000` the body asks the runner to set.

## Decision-point inventory

- Processing update writer — modify — original sourceRecordId → fresh sourceRecordId (spec).
- Source projection: same sourceRecordId + same report + only status/clusterId differ — modify — throw (whole run) → superseded version (legacy lines).
- Source projection: same sourceRecordId + other content or another report — modify — throw (whole run) → quarantine that line; every run degraded until repaired.
- Compaction handoff cursor start — modify — 0 → manifest `startOffset`.
- Compaction of an already-compact generation — modify — new identical generation → no-op.
- Projected clustering scope — modify — includes already-processed rows → skips them (before the duplicate-id check).
- Job outcome classification — modify — model-improvised → fixed script; `degraded` now fails the job.
- Reconciliation (`reconcileSourceProjection`) — unchanged: projected byte ranges are still re-hashed and mismatches still recorded.

---

## 1. Over-block

The old code failed whole runs for one line; the live trigger was not even corruption but
the drain's own writer. Now only a corrupt line is held, and only that line. The job now
fails on any `degraded` run. Every degraded reason is something an operator should see
(authority unavailable or failed, spend brake, readiness source missing, cancellation,
quarantine). The job is priority `low`, so the scheduler alerts after 3 consecutive
failures: a spend brake or an unrepaired quarantine fails every 30-minute run and alerts
within ~90 minutes; a single transient degraded run does not alert.

## 2. Under-block

- A legacy same-id line that changes only `status`/`clusterId` is accepted without an alarm.
  That is the documented LWW update shape; it is never re-projected, so it cannot re-enter
  clustering. A same-id line with any other change is still held.
- "Hold the entity family" (spec §6, corrupt source): the held line never enters the
  projection; later updates of that report under their own ids are projected but are never
  clustered (not `unprocessed`). The report's first, valid line stays the projected record.
- Repair of a held line is operator work (no route added); until then every run is degraded
  and `pruneOperationalHistory` is skipped (existing degraded behaviour), so run/audit
  history grows while the job alerts.
- The job script still depends on the runner executing it verbatim. The body says so and
  the script is one heredoc; a `script`-type job would need a manifest migration for every
  agent, which this does not justify while the prompt route works.
- A proxied tick's outcome is not supervised by any job: it is visible only in the owner's
  run history and `/feedback-factory/drain/status` on the owner.

## 3. Level-of-abstraction fit

The projection rule sits in the store that owns the cursor and the conflict table. The
compaction fix sits in the generation writer, and the cursor fix in the store's handoff
acceptance. The job fix is in the shipped template that `installBuiltinJobs` overwrites
on every update.

## 4. Signal vs authority compliance

Deterministic integrity checks over ids and checksums; no judgment. Quarantine is a
signal (conflict row, hold, audit, degraded run) and no longer blocks unrelated reports.

## 4b. Judgment-point check

No new heuristic at a competing-signals point. The readiness model's prompt and parsing are
untouched; the e2e replays two real gpt-6-astra replies through the unchanged parser.

## 5. Interactions

- `reconcileSourceProjection` re-hashes only projected byte ranges, which still hold their
  original bytes (append-only). Unaffected.
- `acceptSourceHandoff` keeps the "target generation already projected" refusal.
- `pruneOperationalHistory` is skipped on degraded runs, as before; quarantine is the only
  new degraded case, and it persists until repaired.
- `source_integrity_hold` is also set by the generation-missing path and by reconciliation;
  this path lifts only a `source-record-*` hold, and only when the conflict table is empty.
  Nothing reads the hold today.
- Projection rows grow by one per processing update (the spec's model); compaction's copied
  prefix is skipped by `startOffset`.

## 6. External surfaces

`/feedback-factory/drain/status`: `sourceChecksumConflicts` drops to 0 on the live store
after one run. The job's run history now records failures it previously hid.

## 6b. Operator-surface quality

The failure reasons the job records are one line with the drain's own reason and run id.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the source log and drain DB live only on the operated host. The job
on a non-owner proxies the tick as before and now finishes at once. The proxied run's outcome
is visible only in the owner's run history and status; no job supervises it.

## 8. Rollback cost

A code revert. A healed store keeps working on the old code until the next processing
re-append is read, then fails as before. No data is rewritten; the only deletions are the
misclassified conflict rows, each audited.

## Conclusion

Root cause: the processing writer re-appended updates under the original source id, which
the spec calls corruption, and one such line failed every run. The writer now mints a new id,
the 1,000 legacy lines are accepted only because they change status/clusterId alone, real
corruption holds just its line while runs stay loudly degraded, and the live store heals on
its next run. Driving
the real code over a copy of the live store until a full pass completed found and fixed two
compaction costs and a replay double-count on the way, and the job now reports degraded and
failed runs honestly.

## Operator repair of a held source line

Only needed if a run reports `source-record-quarantined` (none on the live store today).
1. Read the held rows: `sqlite3 <stateDir>/state/feedback-factory/store/feedback-drain.db
   "SELECT * FROM source_conflicts"` and the matching `drain_audit` rows
   (`kind='source-record'`). Compare the held line in `feedback.jsonl` (search its
   `sourceRecordId`) with the projected record (`SELECT record_json FROM source_projection
   WHERE source_record_id=?`).
2. Decide: the projected record stays authoritative (the default — nothing else to do), or
   the report needs a fresh correct line, appended through the normal intake.
3. Clear the hold with the server stopped:
   `DELETE FROM source_conflicts WHERE source_record_id='<id>';`
   `INSERT INTO drain_audit(kind,entity_id,from_state,to_state,reason,created_at) VALUES
   ('source-record','<id>','<reason>','operator-cleared','operator-repair:<decision-ref>',<epoch-ms>);`
   and, if the table is now empty, `DELETE FROM drain_meta WHERE key='source_integrity_hold';`.
The next run is no longer degraded by it.

## Spec alignment

`docs/specs/feedback-factory-operating-drain.md` §5 (source discovery, reconciliation) and §6
(corrupt source):
- "Later LWW updates are new source records and receive a new projection sequence" — the
  writer now does this; the defect was the writer reusing the id.
- "Duplicate `sourceRecordId` with a different checksum is corruption and holds" — kept for
  every change except the legacy status/clusterId-only update the old writer produced, which
  is the LWW update the spec describes, written under the wrong id. Those lines are
  superseded, not deleted; the source file is never rewritten.
- "Conflicting rows are … never auto-deleted" — the only deletion is of rows the earlier
  build recorded for those legacy LWW lines, each audited (`cleared-misclassified-conflict`).
  Real conflicts (content or identity) are never deleted.
- "A persistent mismatch … raises one operator attention" — every run stays degraded while a
  held line exists (projection content/identity conflicts and reconciliation checksum
  conflicts), the job fails, and the scheduler's consecutive-failure alert fires. Before this
  change a reconciliation conflict never degraded a run.
- "Source-record uniqueness makes copied live rows idempotent" — unchanged; the compaction
  cursor additionally skips the verified copied prefix.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only)
**Independent read of the artifact (round 1):** concerns raised, all addressed

Round 1 raised: (a) a real quarantine alerted only once, against spec §207 → every run now
stays degraded until repair; (b) a proxied tick polled a run it cannot see for 90 s and
recorded success → finishes at once; (c) worst-case script time (~150 s) exceeded the Bash
tool's 120 s default → 10 s HTTP timeouts, 60 s poll, body asks for `timeout: 300000`;
(d) a non-numeric work count crashed the script → safe parse; (e) the hold-clear removed holds
other paths own → only `source-record-*` holds; (f) the change contradicted spec §5
("later LWW updates are new source records") → redesigned: the writer mints a fresh id and
only legacy status/clusterId-only lines are tolerated; (g) wording in §1, §5, §7 → corrected.
**Round 2:** concur. Notes applied: legacy-update comparison also ignores the re-keyed id
fields (`feedbackId`/`feedback_id`/`id`); `reconciliation-checksum-conflict` rows now count as
held (runs degrade until repaired); the operator repair procedure is written above; proxied-run
wording corrected.

## Evidence pointers

- Live store copy (`sqlite3 .backup`, read-only) at 2026-10-01 16:02 PDT: origin/main fails
  3/3 ticks with the live error. With this change: 1,004/1,004 reports processed, all 746
  clusters evaluated, 45 ready → queued → claimed → completed → read-back Initiative tasks
  (stubbed gpt-6-astra-shaped arbiter through the real parser), stale conflict cleared
  (audit row), 2 generations after compaction (was 6), projection lag 0.
- Real arbiter (production `FeedbackReadinessArbiter` + codex-cli provider, gpt-6-astra
  resolved and accepted): 5 generic clusters → all `collecting` (0.99, 17 s); 5 specific
  multi-report bugs → all `ready` (0.86–0.94, 18–20 s). Both replies are fixtures.
- Tests: `tests/unit/feedback-drain-source-versions.test.ts`,
  `tests/unit/feedback-drain-store.test.ts`, `tests/integration/feedback-factory-drain-service.test.ts`,
  `tests/integration/feedback-factory-process-job-body.test.ts` (real script against a drain
  server), `tests/e2e/feedback-drain-live-shapes.test.ts` (AgentServer + HTTP, real shapes).
  All 14 new tests fail on the pre-fix source.

## Class-Closure Declaration (display-only mirror)

Runtime code defect. Class: a writer that breaks the source-record contract, met by an
integrity check that fails closed for the whole batch. Siblings in the same path:
compaction handoff (re-read), compaction no-op (copy), projected replay (double count) —
all closed here. Reconciliation already scopes to fixed byte ranges and is not a sibling.
