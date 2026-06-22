# Side-Effects Review — JobRunHistory incremental cache (event-loop freeze fix)

**Slug:** `jobrunhistory-incremental-cache` · **Tier:** 1 (focused bug fix, no spec; live-profiler
root-cause). Parent principle: **Structure beats Willpower** — never block the event loop (the third
distinct event-loop blocker behind the dashboard "disconnected" flapping, after sync tmux + sync
keychain reads).

## Summary of the change

`JobRunHistory.readLines()` (`src/scheduler/JobRunHistory.ts`) did `fs.readFileSync` + per-line
`JSON.parse` of the ENTIRE `.instar/ledger/job-runs.jsonl` (~13MB) on EVERY call — and it is on the
hot path of `findRun` / `recordCompletion` / `recordReflection` / `recordHandoff` / `query` / `stats`
/ `allStats` / `getLastHandoff`, all driven by the scheduler every job completion/spawn (~60s
cadence: health-check, commitment-detection, mentor jobs). A live `/usr/bin/sample` caught the main
thread in `ReadFileUtf8 → ParseJson → WriteFileUtf8` — a 13–16s event-loop freeze misreported by
SleepWakeDetector as a ~15s "wake" (the ~0-CPU false-sleep signature). This adds an **incremental
in-memory cache** of parsed runs keyed on the file's `(size, mtimeMs)`: an unchanged file returns the
cache with ZERO IO/parse; an append-only growth reads ONLY the appended tail via `fs.readSync` from
the last offset (O(delta), not O(13MB)); a shrink/rewrite (compaction) triggers one full re-read.

## 1. Correctness / behavioral equivalence

Existing semantics preserved exactly: append-only, dedup-last-wins, torn-line skip, corrupt-file
recovery. `appendLine` keeps the cache coherent so the read after a completion is also free;
`compact()` re-seeds the cache after its rewrite. Verified: 30 original `JobRunHistory` tests + 4 new
regression tests (cache-hit does zero full-file reads across 75 ops; external append picked up via
tail-read; torn-line skipped; full re-read on shrink); the full scheduler suite (incl. MigrationLedger,
reaper, run-record) = 325; 346 total green.

## 2. Cache-coherence / multi-writer safety

The file has two in-process append writers (this instance + `MigrationLedger.appendMigrationEvent`),
both append-only. The `(size, mtimeMs)` key + intact-prefix tail-read handles an external append
correctly (picks up appended rows via tail-read). A shrink (only `compact()` rewrites) forces a full
re-read, so a compaction can never serve a stale cache. The cache is per-process in-memory (not
shared) — no cross-process coherence concern (each process reads its own view, same as before).

## 3. Fail-safe

The new fail paths (cache read, tail-read, stat) fall back to a full re-read or to the prior
behavior; each genuinely fail-safe catch is tagged `@silent-fallback-ok`. A stat/read error degrades
to a full re-read (correct result, just not the fast path) — never wrong data, never a crash.

## 4. Blast radius

One module (`JobRunHistory.ts`) + its test. No API/route change, no schema change, no write-path
semantics change (`compact()` still rewrites on its existing cadence — see the residual note). No
new external surface.

## 5. Residual (tracked, NOT fixed here — out of scope)

`job-runs.jsonl` grows UNBOUNDED to 13MB (and the cartographer `index.json` is 91MB) — a genuine
Bounded-Accumulation issue. The cache makes READS cheap regardless of size, but `compact()` still
does a full synchronous ~13MB WRITE on startup, and the file keeps growing. A retention/rotation cap
on `job-runs.jsonl` (and the cartographer index) is a separate Bounded-Accumulation follow-up worth
filing — named here so it is not silently dropped.

## 6. Rollback

Revert the one source file. The change is purely a read-path cache; reverting restores the (slow but
correct) full-read behavior.
