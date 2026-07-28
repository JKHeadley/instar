# Side-Effects Review — Reaper self-inflicted log-flood fix (ReapLog transition-dedup + bounded read + rotation)

**Version / slug:** `reaper-log-flood-fix`
**Date:** `2026-07-03`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `reviewer subagent (see appended concurrence)`

## Summary of the change

Three self-limiting changes to `src/monitoring/ReapLog.ts`, the append-only audit trail behind `GET /sessions/reap-log`:

1. **Write-side transition dedup (primary cure).** `recordSkipped()` now logs on TRANSITION only — it keeps an in-memory `session → last-logged skip signature (${reason}::${skipped})` map and drops a re-append when the signature is unchanged. The reaper re-evaluates a permanently-vetoed session (`open-commitment`, `not-lease-holder`, `protected`) on every tick and previously appended an identical `skipped` row each time — on a live agent this produced 3218 `open-commitment` + 1608 `not-lease-holder` repeat rows and grew the log to 142MB / 463k lines (observed 2026-07-03). The dedup state is cleared when the session is reaped (`recordReaped` → `forgetSkip`) so a same-named successor logs fresh and the map cannot leak. The map has a hard ceiling (`MAX_SKIP_STATE`, default 2000, oldest-pruned).
2. **Read-side bounded tail (fixes the freeze-on-read).** `read()` previously did `fs.readFileSync(WHOLE file).split('\n')` just to return the last `limit` rows — a 142MB slurp + split that blocked the event loop when the route was queried. It now reads only the last `TAIL_READ_BYTES` (default 2MB) of the file via a positional `readSync`, drops a leading partial line, and merges the rotated `.1` tail if the live file doesn't yield enough rows.
3. **Size-cap rotation (defense-in-depth).** `append()` rolls the file to `<path>.1` (O(1) `renameSync`, no data rewrite on the hot path) once it would cross `MAX_LOG_BYTES` (default 16MB), so the file can never grow unbounded even if a future caller floods it. One backup generation is retained; `read()` merges it.

The caps are overridable via an optional `ReapLogOptions` constructor arg (defaults = module constants) purely so tests can trigger rotation cheaply. The production callsite (`src/commands/server.ts`) is unchanged.

## Decision-point inventory

This change touches NO block/allow/gate decision point. `ReapLog` is a read-only observability sink — the class docstring states it "never gates or mutates a session — it only records." The reaper's keep/kill authority (`SessionManager` / `SessionReaper`) is entirely untouched; only the LOGGING cadence and READ mechanics change.

- `ReapLog.recordSkipped` — modify — logs on transition instead of every tick (observability cadence only).
- `ReapLog.read` — modify — bounded tail read instead of whole-file slurp (I/O mechanics only).
- `ReapLog.append` — modify — adds O(1) size-cap rotation (I/O mechanics only).

---

## 1. Over-block

No block/allow surface — over-block not applicable. `ReapLog` never blocks a session. The only "suppression" is of DUPLICATE LOG ROWS for an unchanged skip state, which is the intended behavior (mirrors the existing `reaper-audit.jsonl` log-on-transition pattern).

---

## 2. Under-block

No block/allow surface — under-block not applicable. In audit-fidelity terms, the analogue is "what does the log no longer record?": it no longer records a fresh row for an UNCHANGED skip state on each tick. It STILL records: the first skip (transition into skipped), every change of skip reason, and every reap. A reviewer asking "is this session still being skipped?" reads the most recent skip row plus the absence of a later reap — the same answer, without 5000 duplicate rows. Loss of the per-tick "still skipped at time T" heartbeat is intentional and matches reaper-audit.

---

## 3. Level-of-abstraction fit

Correct layer. The dedup lives INSIDE `ReapLog` (the class that owns the log), so it covers every caller — not bolted onto the single `reapBlocked` event wiring in `server.ts`, which would leave other/future callers un-deduped. The read/rotation are pure file mechanics that belong on the class that owns the file. This is a detector/observability primitive, not an authority — it produces no signal consumed by any gate. It mirrors the already-shipped `reaper-audit.jsonl` transition pattern rather than inventing a new one.

---

## 4. Signal vs authority compliance

Compliant. The change adds NO blocking authority and NO brittle decision logic in front of any gate. It is a data-sink optimization: fewer duplicate rows written, bounded bytes read. `docs/signal-vs-authority.md` governs decision points; this change has none.

---

## 5. Interactions

- **Mirrors, does not shadow, `reaper-audit.jsonl`.** That sink already logs reaper decisions on transition; this brings `reap-log.jsonl`'s skip rows to the same discipline. They remain separate files with separate purposes.
- **`recordReaped` → `forgetSkip` ordering.** Reap clears the skip-state so a same-named successor logs fresh. A reap for a session never previously skipped is a harmless no-op delete.
- **No race with cleanup.** `ReapLog` is synchronous and single-process; the rotation `renameSync` is atomic. A concurrent reader mid-rotation either sees the old file (pre-rename) or the new empty file + `.1` (post-rename) — `read()` merges `.1`, so no window loses the newest rows.
- **`normalizeEntry` untouched** — the notify/skipped/reaped type + field whitelist that other tests guard is unchanged; all 115 reaper-family unit tests pass.

---

## 6. External surfaces

- **`GET /sessions/reap-log`** — same JSON shape, same newest-last ordering, same `limit` semantics. The only observable difference: far fewer duplicate `skipped` rows, and the route no longer blocks the event loop on a large file. No API contract change.
- No change visible to other agents or users beyond the route above. No dependency on timing or conversation state.
- **Pre-existing on-disk bloat is not rewritten by this change.** A file already at 142MB stays until the next rotation trims it (or an operator archives it, as was done live on 2026-07-03). The bounded READ means even a still-large file no longer freezes the loop; the write-side dedup means it stops growing.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** `reap-log.jsonl` is a per-machine audit of that machine's own reap decisions (the log path is under the machine's own `logs/`, and `GET /sessions/reap-log` already reports only the local machine's entries — pool-scope reap history is not a feature). The in-memory `skipState` dedup map is likewise per-process and correctly scoped to the machine doing the reaping. No replication, no proxied read, no cross-machine state. This matches the existing `reaper-audit.jsonl` posture. No topic-transfer, one-voice, or URL-durability concerns (it is not user-facing and generates no links).

---

## 8. Rollback cost

Low. The change is contained to one file (`ReapLog.ts`) plus its unit tests. Back-out is a straight revert — no data migration (the on-disk format is unchanged; older whole-file logs and `.1` backups both read correctly through the new tail reader). If the transition-dedup were ever suspected of hiding a needed row, reverting restores per-tick logging immediately. No agent-state repair, no hot-fix data surgery. The caps are constructor-overridable if a deployment needs different thresholds without a code change.

---

## Second-pass review (independent reviewer subagent)

**Concur with the review.** The change is observability-only and touches no kill/keep decision — the reaper still evaluates every tick, so the transition-dedup can never strand an operator's "why did my session vanish / not get reaped?" answer.

1. **Transition-dedup:** correctly keyed on `${reason}::${skipped}`; suppresses only a byte-identical re-evaluation of the same permanent veto. Any genuine change (veto lifts → reap row always appends since `recordReaped` has no dedup; reason changes → new signature → new row) is still logged. `forgetSkip` on reap prevents both the stale-successor bug and unbounded map growth, backed by the `MAX_SKIP_STATE` oldest-first ceiling. No operator-needed row is hidden.
2. **Bounded read:** traced the merge/tail logic — older `.1` correctly prepended to newer live, `.slice(-limit)` keeps the newest, leading partial line dropped only when `start > 0`, trailing empty line filtered, `.1` read only when live yields `< wanted`. No off-by-one, no torn record, newest row never dropped, no cross-file duplication (rename→fresh-empty-live).
3. **Rotation:** O(1) `renameSync` off the hot path; `approxSize` seeded once then advanced per-write (no per-append stat); a pre-existing 142MB file rotates on the first append. On-disk bounded to `live (≤cap) + .1 (≤cap)` since each rotation overwrites the prior `.1`. Concurrent reader sees a consistent pre/post-rename state, both handled by `read()`.
4. **Signal-vs-authority:** no blocking authority added; `SessionReaper`/`SessionManager` kill logic untouched; audit-sink failures swallow silently rather than perturbing behavior.

No correctness defect found. Tests exercise both sides of the dedup boundary, the rotation/merge boundary, and the absent-file path. Sound to merge.
