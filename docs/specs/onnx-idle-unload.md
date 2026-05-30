---
title: EmbeddingProvider idle-unload — dispose the ONNX pipeline when idle to stop the thread-pool busy-spin
date: 2026-05-30
author: echo
review-convergence: robustness-load-2026-05-30
approved: true
approved-by: Justin
approved-via: 12h autonomous mentorship+robustness session mandate — "treat load as suspect → diagnose as a bug" + "any Instar robustness issue I find, I fix as a proper fleet PR (full ship-gate)". This is a measured fleet-load fix (idle CPU waste). Reported to Justin in topic 13435.
eli16-overview: onnx-idle-unload.eli16.md
---

# Spec — EmbeddingProvider idle-unload

**Date:** 2026-05-30
**Author:** echo
**Status:** approved (robustness / fleet-load fix)

## Problem (measured live)

`EmbeddingProvider` (the shared local embedding service backing SemanticMemory,
MemoryIndex, TopicMemory) loads the all-MiniLM-L6-v2 ONNX model lazily on first
`embed()` and then **keeps it resident forever**. onnxruntime's thread pool
**busy-spins even when no embedding is happening**. Measured on a live box via
`process.cpuUsage()` over a 3s idle window with the model loaded:

- **IDLE-while-LOADED: ~3.6% of one core** on a quiet process — and previously
  observed at **~44%** on a contended agent (AI Guy) that was supposedly "paused".

That is pure wasted CPU for any agent that isn't actively doing memory work. With
several agents on one box each holding an idle, spinning model, it's a real,
multiplied contributor to fleet load — exactly the "load is suspect" signal this
session was asked to chase.

## Fix

Idle-unload the pipeline. After `idleUnloadMs` (default 300000 = 5 min) with no
`embed()` call, dispose the loaded pipeline — freeing the onnxruntime session +
its thread pool — and lazily reload on the next `embed()`.

- A rolling timer is re-armed on every embed (entry/exit), so an actively-embedding
  agent keeps the model resident; one that goes quiet unloads it.
- An `inFlight` counter guards `maybeUnload()` so a long-running batch that outlasts
  the window is never disposed mid-flight (its completion re-arms the timer).
- The timer is `unref()`'d so it can never hold the process open on its own.
- `idleUnloadMs: 0` disables the behavior (keep resident — the prior behavior).
- A public `dispose()` releases the model + cancels the timer for shutdown/tests.

## Verification (live, not just unit)

Ran the real model through `process.cpuUsage()`:
- **IDLE-while-LOADED: 3.6% of one core** → **IDLE-after-DISPOSE: 0.0%**. `dispose()`
  exists on the pipeline and stops the spin.
- **dispose → reload → embed produced an IDENTICAL embedding** (`[0]=-0.0345` both
  before and after; `RELOAD CYCLE OK`), confirming the lazy reload is correct and
  the dispose+reload pattern is clean (no mutex/exit race in the production path,
  which disposes during idle and keeps running).

## Testing

- `tests/unit/EmbeddingProvider-idle-unload.test.ts` (5, mock pipeline + fake
  timers): disposes after the idle window + lazily reloads; stays resident while
  embeds keep coming (timer resets); `idleUnloadMs:0` disables; inFlight guard
  (never disposes mid-embed, disposes once idle); explicit `dispose()` releases +
  cancels the timer.
- `tsc` clean. `isReady` is not used by any caller to gate embeds, so its now-dynamic
  value (can flip false after unload) is safe. The production singleton
  (`server.ts`) constructs with defaults → idle-unload ON at 5 min.

## Scope / tuning

Internal runtime logic in `src/memory/`. No agent-installed file, config schema,
or migration changes (the default lives in the constructor config). `idleUnloadMs`
is tunable via the `EmbeddingProvider` constructor; wiring it to `.instar/config.json`
can be added later if an operator needs to tune it without a code change.
