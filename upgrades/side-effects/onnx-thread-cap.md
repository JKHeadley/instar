# Side-Effects Review — Cap embedding ONNX thread pool

**Version / slug:** `onnx-thread-cap`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

One config value on the `feature-extraction` pipeline creation:
`session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }` (extracted to the exported
`ONNX_SESSION_OPTIONS` const). Fleet-wide — every agent's EmbeddingProvider. No logic change.

## Decision-point inventory

None. It's a thread-pool sizing hint to ONNX Runtime; no new branch, no decision surface.

## 1. Correctness

Thread count does not affect embedding *output* — only how the inference is parallelized internally.
Verified directly: the runtime probe produced an identical 384-dim vector with the cap. The existing
idle-unload unit suite (dispose→reload lifecycle) is unchanged and green.

## 2. Latency / throughput

all-MiniLM-L6-v2 is a small model (~80MB, 384-dim) and instar memory embeds are sporadic
(single-text semantic-search queries, occasional digest batches). Single-text inference on this model
is already sub-100ms; the intra-op pool gave little speedup for it but cost a resident busy-spin. For
the rare large `embedBatch`, throughput could be marginally lower — acceptable, and far outweighed by
eliminating ~0.5 core/agent of idle waste. (If a heavy-batch consumer ever proves sensitive, the cap
is a one-line constant to raise.)

## 3. Blast radius

Bounded. Worst case is a no-op (if a future transformers.js version ignored the key) or marginally
slower batch embeds — both recoverable by reverting one constant. It cannot break embedding,
search, or memory; it cannot affect any non-embedding path.

## 4. Verification method (load-independent)

CPU% on a contended box is noisy, so verification used **thread count** (load-independent): a probe
created a real EmbeddingProvider, embedded, and counted process threads while resident — 18 (default)
vs 12 (capped). The 6 freed threads are the ORT intra-op spinners. Reproducible probe pattern:
construct provider → `initialize()` → `embed()` → `ps -M <pid> | wc -l`.

## 5. Reversibility

Pure config constant; no migration, no persisted state. Revert = revert the constant.

## Verdict

Bounded, output-preserving, fleet-wide CPU win. Eliminates the resident ONNX busy-spin (~0.5
core/agent) that was the dominant recurring host-load source, with no change to memory behavior.
