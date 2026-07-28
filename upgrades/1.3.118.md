# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**The shared local embedding model now unloads when idle, freeing the CPU its
ONNX thread pool was busy-spinning on.**

`EmbeddingProvider` (backing SemanticMemory / MemoryIndex / TopicMemory) loaded the
all-MiniLM-L6-v2 ONNX model lazily and then kept it resident forever. onnxruntime's
thread pool busy-spins even when idle — measured live via `process.cpuUsage()` at
~3.6% of a core on a quiet box, and previously ~44% on a contended agent that was
supposedly paused. With several agents per box each holding an idle, spinning
model, that's a real multiplied load source.

Fix: after `idleUnloadMs` (default 300000 = 5 min) with no `embed()`, the pipeline
is disposed (thread pool freed) and lazily reloaded on the next embed. A rolling
timer resets on every embed (active agents stay resident), an `inFlight` guard
prevents disposing mid-batch, and the timer is `unref()`'d. Set `idleUnloadMs: 0`
to keep the prior keep-resident behavior. Verified live: idle CPU 3.6% → 0.0% after
dispose, and dispose→reload→embed produces an identical vector.

## What to Tell Your User

Each agent keeps a small local AI model loaded to search its own memories, and the
engine running that model was quietly burning CPU even when the agent was idle —
its worker threads spin in a tight loop instead of sleeping. On a machine running
several agents, that added up to real wasted CPU. I changed it so the model unloads
after a few minutes of not being used and reloads in about a second the next time
it's needed. Active memory work is unaffected (the timer resets every time it's
used); only genuinely idle agents stop wasting CPU. I confirmed the model produces
the exact same results after an unload-and-reload, so nothing is lost.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Idle-unload of the embedding model | Automatic — frees the ONNX thread pool after ~5 min idle, reloads on next use |
| Keep the model resident | Construct the embedding provider with the idle window set to zero |

## Evidence

- **Live measurement:** loaded-but-idle model used ~3.6% of a core (3s window,
  `process.cpuUsage()`); ~44% previously observed on a contended agent. After
  dispose: 0.0%. dispose→reload→embed produced an identical embedding.
- **Tests:** `tests/unit/EmbeddingProvider-idle-unload.test.ts` (5, mock pipeline +
  fake timers) — dispose-after-idle + lazy reload, resident-while-active,
  disable-via-zero, inFlight guard, explicit dispose. `tsc` clean.
- Spec: `docs/specs/onnx-idle-unload.md`. Side-effects:
  `upgrades/side-effects/onnx-idle-unload.md`.
