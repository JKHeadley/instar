# Side-Effects Review — correction capture-backlog with retry

**Version / slug:** `correction-capture-backlog`
**Date:** `2026-06-02`
**Author:** `echo`
**Second-pass reviewer:** `pending`

## Summary of the change

Adds `src/monitoring/CorrectionCaptureBacklog.ts` — a bounded, durable SQLite store
that persists pre-scrubbed captures the Correction & Preference Learning Sentinel
could not distill because the LLM was rate-limited (daily-cap / reserve-breach /
aborted / circuit-breaker-open). `CorrectionCaptureLoop.captureAndDistill` now, in
its distill catch block, classifies the rejection via the new `isCapacityThrow`: a
CAPACITY rejection enqueues the pre-scrubbed capture to the backlog (audit decision
`distill-backlogged`) instead of dropping it; a genuine fault still drops
(`distill-dropped`). A new `drainBacklog` distills backlogged entries into the
`CorrectionLedger` off the hot path, breaker-gated on `llmCircuitAvailable()`,
triggered after a successful live distill and by a 5-minute periodic sweep. Four
config dials (`captureBacklogMaxEntries` default 200, `captureBacklogTtlHours`
default 24, `captureBacklogDrainPerTick` default 5, `captureBacklogMaxRetries`
default 3) backfill via `applyDefaults`; maxEntries=0 disables the backlog.

## Decision-point inventory

- `captureAndDistill: distill threw — backlog or drop?` (CorrectionCaptureLoop.ts) —
  **new branch** — a capacity throw now persists (was: always drop). A non-capacity
  throw is unchanged (drops). Wrapped in try/catch → a backlog fault falls back to drop.
- `drainBacklog: is the LLM available?` (CorrectionCaptureLoop.ts) — **new gate** —
  skips the whole drain while the breaker is open; re-checks between entries.
- `server.ts: construct the backlog?` — **new gate** — constructed IFF the feature is
  enabled AND `captureBacklogMaxEntries > 0`. Else null (old drop behavior).
- `CorrectionCaptureBacklog.enqueue: at the cap?` — **new** — evicts oldest on overflow;
  dedupes a near-identical entry instead of inserting a duplicate.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** Nothing in this change can
reject, block, delay, or gate a message or an operation. The backlog/drain only
move an internal observe-only record (a distilled correction) from a deferred state
to the ledger. The worst over-reach is a redundant LLM distill call on an entry that
would have been noise — bounded by `captureBacklogDrainPerTick` (5) per sweep and by
the per-sentinel daily LLM cap (the drain shares the same `correctionLlmQueue`
budget, so it cannot exceed the feature's existing spend ceiling).

---

## 2. Under-block

**What does it still miss?** `isCapacityThrow` is conservative — an unrecognized
error string is treated as a non-capacity fault and DROPS (preserving old behavior),
so a novel provider rate-limit phrasing not in the matcher would still be dropped
rather than backlogged. That is the safe direction (no false persistence). A capture
also still drops if the backlog enqueue itself faults (disk full) — again fail-open,
no worse than today. Entries that exhaust `captureBacklogMaxRetries` or age past the
TTL are intentionally discarded (bounded retention), so a persistently-un-distillable
capture is eventually dropped by design.

---

## 3. Level-of-abstraction fit

Correct layer. The backlog mirrors `CorrectionLedger`'s own SQLite discipline (WAL,
prune-in-transaction, indexes, fail-open, `NativeModuleHealer` open, `SqliteRegistry`
close-on-exit) and lives beside it in `src/monitoring/`. The drain reuses the existing
`buildDistillPrompt` / `parseDistillEnvelope` rather than inventing a second distill
path, and rides the existing account-global `LlmCircuitBreaker` via its pure
`llmCircuitAvailable()` read rather than adding a parallel availability notion.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No authority added — this change produces and defers a SIGNAL (a distilled
  correction record) consumed by the existing `CorrectionAnalyzer` / `CorrectionLoopDriver`,
  which own every downstream decision. The backlog cannot mint a proposal, write a
  preference, post feedback, or change policy; it only delays then completes the same
  ledger write the hot path would have done. The `CorrectionLoopDriver`'s
  by-construction authority guard (no proposal-mint, no memory-write) is untouched.

---

## 5. Interactions

- **Shadowing:** none — the backlog is a NEW db file (`correction-capture-backlog.db`),
  separate from `correction-ledger.db`; no existing query path changes.
- **LLM budget:** the drain shares the per-sentinel `correctionLlmQueue` daily cap, so
  it competes with (never exceeds) the existing distill budget — and it only runs when
  `llmCircuitAvailable()` is true, so it cannot pile onto an already-throttled account.
- **Circuit breaker:** the drain is a pure consumer of the breaker's read state; it does
  not trip, reset, or consume a half-open probe slot.
- **Multi-machine:** the db is per-stateDir (per machine), like the ledger; no mesh
  coordination needed (the worst case is each machine independently distilling its own
  backlogged captures, which dedupe-collapse in the ledger by `dedupeKey`).

---

## 6. Privacy / data exposure

**This is the load-bearing dimension and the central design constraint.**

- **Persist-pre-scrubbed-only posture.** The backlog persists ONLY the
  already-pre-scrubbed turns. The §3.3 deterministic `scrubSecrets` runs inside
  `buildDistillPrompt` BEFORE the catch that enqueues, and `enqueue` re-scrubs every
  turn defensively (belt-and-suspenders) so even a mis-wired caller cannot write raw
  text. Unit-proven: a `ghp_…` token in a turn is `gh***_REDACTED` on disk
  (`CorrectionCaptureBacklog.test.ts` + `CorrectionCaptureBacklog-drain.test.ts`).
- **Bounded retention.** Max-entries cap (oldest evicted) AND a TTL (stale pruned),
  and every entry is DELETED the instant it distills (`markDistilled`) or exhausts its
  retries (`bumpAttempt`). It is a bounded, time-limited extension of the existing
  ephemeral look-back ring — not a new long-lived data sink.
- **No new exposure surface.** No API route serves backlog row content; the scrubbed
  turn text never crosses HTTP. The only observable is a count. The E2E pins that the
  drained record surfaces on GET /corrections with ONLY its scrubbed summary (raw
  learning absent from the payload), exactly like the existing ledger guarantee.

---

## 7. Failure modes / rollback

- **Fail-open everywhere.** Every backlog method swallows storage errors and returns a
  safe default; `captureAndDistill`'s backlog enqueue is wrapped in try/catch and falls
  back to the old drop; `drainBacklog` is fully detached (`void`/async), single-flight
  guarded, and its top-level catch can never throw into a seam. A backlog fault degrades
  to exactly the pre-change behavior (drop-on-throttle).
- **Rollback.** Per-agent: set `monitoring.correctionLearning.captureBacklogMaxEntries`
  to 0 — the backlog is not constructed and the loop reverts to the old drop. Whole
  feature: the existing `monitoring.correctionLearning.enabled` dark gate. No schema
  migration is destructive (a new db file); deleting `correction-capture-backlog.db`
  is safe and just discards any pending retries.
- **Boot cost.** The store opens an empty WAL db with two small indexes — no boot-time
  full-scan (the `TokenLedger` backfill-boot-hang class is explicitly avoided; there is
  no startup scan, only on-demand claim/prune).
