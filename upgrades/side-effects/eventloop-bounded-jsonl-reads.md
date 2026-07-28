# Side-Effects Review — bounded tail-reads for the 12MB telegram-log + 14MB feedback-store (event-loop freeze fix)

**Slug:** `eventloop-bounded-jsonl-reads` · **Tier:** 1 (focused low-risk bounded-read class fix, no
spec; live-profiler root-cause). Parent principles: **Structure beats Willpower** — never block the
event loop (the THIRD + FOURTH distinct event-loop-blocker class behind the dashboard "disconnected"
flapping, after sync tmux + sync keychain + the JobRunHistory 13MB re-read); and **Bounded
Accumulation** (the size of an append-only log must never determine the cost of reading it).

## Summary of the change

FOUR callers each did `fs.readFileSync(messageLogPath, 'utf-8')` on the ~12MB
`.instar/telegram-messages.jsonl` just to inspect the last 50–200 lines:
- `CommitmentSentinel.parseRecentMessages` (`src/monitoring/CommitmentSentinel.ts`) — 5-minute timer,
  only ever looks at the last `maxMessagesPerScan*10` lines.
- `CoherenceMonitor` output-sanity check (`src/monitoring/CoherenceMonitor.ts`) — 5-minute timer,
  only ever looks at the last 50 agent messages.
- `checkLogForAgentResponse` (PresenceProxy ack path, `src/commands/server.ts`) — event-driven on
  every PresenceProxy tier verdict, only ever looks at the last 50 lines.
- `TelegramAdapter.getMessageLog` (`src/messaging/TelegramAdapter.ts`) — analysis route, only ever
  returns the last `limit` (default 100) entries.

A 12MB synchronous read + `.split('\n')` on a 5-minute timer froze the event loop for up to ~20s per
pass — the same ~0-CPU false-sleep signature the JobRunHistory fix removed. PLUS `JsonlFeedbackStore`
(`src/feedback-factory/store/JsonlFeedbackStore.ts`) re-read + re-`JSON.parse`d the entire ~14MB
`feedback.jsonl` at the start of every processing pass even when nothing had changed.

The fix is two behavior-preserving mechanisms:

**(A) A shared bounded tail-read utility** — `src/utils/jsonl-tail.ts` (`readJsonlTailLines` /
`readJsonlTailLastLines`). It `statSync`s the file (O(1)), `openSync` + `readSync`s only the trailing
`maxBytes` (default 512KB ≈ ~2,600 recent lines, far more than any caller needs) into a fixed buffer,
drops the first partial line when the window started mid-file, and returns the trailing lines in file
order. It NEVER loads the whole file and NEVER throws (a read failure returns an empty result,
matching the `@silent-fallback-ok` behavior of every former full-file caller). It mirrors
`CoherenceJournal.readTailTolerant`, generalized off that journal's typed-entry shape. The four
telegram-log readers above now call it instead of `readFileSync`.

**(B) A `(size, mtimeMs)` load cache in `JsonlFeedbackStore.loadJsonl`** — when the on-disk file is
byte-for-byte the one last folded, it serves a clone of the prior parse with ZERO IO/parse; any
change (append, shrink, delete) re-reads from disk. Mirrors the JobRunHistory cache pattern. The
clone-on-serve guarantees a caller mutating the returned Map can never poison the cache.

## 1. Correctness / behavioral equivalence

The telegram-log readers each consumed only a fixed tail (last 50 / last 200 / last `limit`) of the
log, so the 512KB window (≈ 2,600 lines) is strictly a superset of every caller's need — the parsed +
filtered result is identical to the old full-split-then-slice. The partial-first-line drop guarantees
a truncated record at the window boundary is never mis-parsed. The feedback store's load semantics
(per-line parse, dedup-last-wins-by-id, torn-line skip, corrupt-file recovery) are preserved exactly;
the cache is only consulted when the fingerprint matches and is invalidated on any change. Verified:
48/48 across the four touched test files (`jsonl-tail` 9, `CoherenceMonitor-bounded-read` 2,
`CommitmentSentinel` 26, `jsonl-feedback-store` 11) plus the cross-impact suites; tsc exit 0; lints
green. The two new regression tests spy on `fs.readFileSync` to FAIL if the whole telegram log is
read, AND prove a bad pattern in a RECENT agent message at the END of a multi-MB log is still
detected via the tail.

## 2. Cache-coherence / multi-writer safety

The telegram-log tail-read holds no state — every call re-reads the live tail, so a concurrent
appender is always reflected. The feedback-store `(size, mtimeMs)` key invalidates on any byte/mtime
change (append, compaction rewrite, delete-then-recreate), so an unchanged file is the only cache-hit
case and a stale fold can never be served. The cache is per-process in-memory (not shared) — no
cross-process coherence concern (each process reads its own view, same as before). `loadCache` is
keyed per absolute path and dropped on `existsSync` failure.

## 3. Fail-safe

`jsonl-tail.ts` never throws: missing file, stat failure, open/read failure each return an empty
result — exactly the prior `@silent-fallback-ok` degradation of the full-file callers (an
observability/housekeeping read must never endanger the observed operation). The feedback store's
stat-failure path falls through to a full read (`/* fall through to a full read — never let stat
failure skip the load */`), so a stat error degrades to the correct (slow) result, never wrong data.

## 4. Blast radius

One new utility module + its test; four read-site one-liner swaps (CommitmentSentinel, CoherenceMonitor,
server.ts PresenceProxy ack, TelegramAdapter.getMessageLog); one read-path cache in JsonlFeedbackStore
+ a test-only cache-clear export. No API/route change, no schema change, no write-path semantics
change, no new external surface.

## 5. Residual (tracked, NOT fixed here — out of scope)

The existing `lint-no-wholefile-sync-read` ratchet only catches LITERAL path basenames in the read
call, but these four sites read VARIABLE paths (`this.messageLogPath`, a `logPath` param), so the
lint could never have flagged them — which is why they survived the earlier sweeps. The durable
structural prevention is an **accessor funnel** (route all append-log reads through a single bounded
accessor that the lint can enforce), which is **Bounded Accumulation Increment 2** — a tracked
follow-up named here so it is not silently dropped. Separately, the telegram-messages.jsonl and
feedback.jsonl files themselves still grow UNBOUNDED — a size/retention cap is the same Bounded
Accumulation track. This change makes READS cheap regardless of size; it does not cap the files.

## 6. Rollback

Revert the source files. The change is purely read-path (a bounded tail-read + a fingerprint cache);
reverting restores the (slow but correct) full-read behavior. No data migration, no on-disk format
change to undo.
