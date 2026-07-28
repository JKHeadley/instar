# Side-effects — EmbeddingProvider idle-unload

**Change:** `EmbeddingProvider` disposes its loaded ONNX pipeline after
`idleUnloadMs` (default 5 min) of no `embed()` call, lazily reloading on the next
embed. New `inFlight` guard, rolling idle timer, and a public `dispose()`.

## Behavioral side-effects

- **First embed after a long idle costs ~1-3s more** (a model reload). All
  subsequent embeds during active use are unaffected — the idle timer resets on
  every embed, so a busy agent keeps the model resident. Memory search/index are
  not latency-critical, so the occasional reload is an acceptable trade for
  eliminating the idle thread-pool spin (~3.6%-44% of a core).
- **`isReady` is now dynamic.** Previously it returned true forever once loaded;
  now it returns false while the model is unloaded between idle periods. No caller
  uses `isReady` to gate embeds (verified) — `embed()` lazily re-initializes
  regardless — so this is observational only.
- **Embeddings are unchanged.** Verified live: dispose→reload→embed produces a
  byte-identical vector. Unloading/reloading never alters output.
- **Default-ON.** The production singleton constructs with defaults, so all agents
  get 5-min idle-unload on update. Set `idleUnloadMs: 0` (constructor config) to
  restore the prior keep-resident behavior.

## Blast radius

- Scoped to `src/memory/EmbeddingProvider.ts`. SemanticMemory / MemoryIndex /
  TopicMemory consume it transparently (they call `embed()`/`embedBatch()`, which
  handle reload internally). No call-site changes.
- The idle timer is `unref()`'d — it can never keep the process alive.
- No config schema, hook, or HTTP changes. No new dependencies.

## Migration parity

None required — internal runtime logic in `src/`. No agent-installed file
(`.claude/settings.json`, `.instar/config.json`, CLAUDE.md template, hook, skill)
changes. Existing agents receive it on their normal version update.
