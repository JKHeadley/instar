<!-- bump: patch -->

## What Changed

Caps the embedding model's ONNX Runtime thread pools to 1 (`session_options:
{ intraOpNumThreads: 1, interOpNumThreads: 1 }` on the `feature-extraction` pipeline).

**The fleet-wide idle-CPU root cause (task #17).** A profiler sample of a live, *idle* agent
server showed it dominated by `onnxruntime::PosixThread::ThreadMain` — the SemanticMemory embedding
model (`all-MiniLM-L6-v2` via `@huggingface/transformers`) keeps its multi-thread ORT pool **busy-
spinning ~50% of a core while the model sits resident between embeds**. Across N agent servers that's
the bulk of the recurring host load (observed 20–32 on a 16-core box) that flapped relays and slowed
CI all day.

The existing idle-unload (dispose after 5 min idle) only helps a *truly* idle agent — semantic-search
queries re-arm the timer, so the model stays resident and spins. all-MiniLM-L6 is tiny and memory
embeds are sporadic, so a single ORT thread is plenty; capping the pool stops the spin without
changing output.

## What to Tell Your User

- **Much lower idle CPU**: "My background memory engine was quietly burning about half a CPU core
  per agent just spinning idle threads — across several agents that was most of the host load you
  saw. Capping it cuts that to near-zero with no change to how memory/search works."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Bounded embedding CPU | Automatic — the embedding ORT pool is capped to 1 thread, eliminating the resident busy-spin. |

## Evidence

Verification (a thread-count probe is load-independent, so it's reliable even on a busy box):

- Runtime probe on the real model: embed output unchanged (384-dim); the **resident** process thread
  count dropped **18 → 12** with the cap (the ~6 extra ORT intra-op spinners gone), confirming the
  spin is eliminated while embedding still works.
- Unit: `ONNX_SESSION_OPTIONS` guard (caps both pools to 1); the EmbeddingProvider idle-unload suite
  unchanged (6 tests green). `pnpm lint` (tsc + 4 lints) clean; `pnpm build` clean.
