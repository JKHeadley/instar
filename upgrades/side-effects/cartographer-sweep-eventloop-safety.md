# Side-Effects Review — Cartographer Sweep Event-Loop Safety (fix instar#1069)

**Version / slug:** `cartographer-sweep-eventloop-safety`
**Date:** `2026-06-12`
**Author:** `echo`
**Second-pass reviewer:** `required` (touches a sentinel/breaker, a recovery/boot path, and HTTP route shapes)

## Summary of the change

Closes the complete class of O(nodeCount)/67MB synchronous cartographer operations that ran on the AgentServer's main event loop and put it into a supervisor kill-loop when the doc-freshness sweep was enabled on a real tree (366,757 nodes / 67MB `index.json`). The "what's stale?" detect, the revalidation re-parse, the request-path lazy scaffold, the health-route freshness walk, the under-buffered `git ls-tree`, and the per-node author-path index write all moved OFF the main thread. New: `src/core/cartographerDetect.ts` (pure, bounded detect/index-write module — heap-pass ordering, byte-guard, explicit 64MB git buffer, refusal taxonomy, zero node-file reads) + `src/core/cartographerDetect.worker.ts` (trivial worker entrypoint). `CartographerSweepEngine.runPass` now runs detect in a `worker_threads` worker (rollback: `detectInWorker:false` runs the same bounded module synchronously), batches all index updates into one off-thread write, single-flights, and remains lease-gated. Every `/cartographer/*` read route serves a per-host snapshot (`CartographerTree.readSnapshot`) or a byte-bounded load (`loadIndexBounded`), never a walk; the lazy `scaffold()`/`loadIndex()` preamble is gone and a boot-path chunked `scaffoldChunked` builds the index off-request. `CartographerIndexEntry` gained three optional mirrored fields (`staleSincePass`/`firstSeenAt`/`authorFailed`) so detect needs no node-file reads. A new path-allowlist lint (`scripts/lint-no-mainthread-cartographer-walk.js`) forbids the heavy calls in `routes.ts` + `CartographerSweepEngine.ts`. Migrations: config defaults (9 new `freshnessSweep` fields via `applyDefaults` backfill), `.instar/cartographer/` gitignore (init + repo + `PostUpdateMigrator`), and a `migrateClaudeMd` block. `cartographer.freshnessSweep.framework` is now honored as the sweep's routing (`resolveSweepFrameworkRouting`, explicit-set-only, boot-logged).

## Decision-point inventory

- `CartographerSweepEngine.probeRouting` — pass-through — unchanged; the off-Claude refusal floor (resolve-to-default + `!allowClaudeFallback` → refuse) is preserved verbatim.
- `CartographerSweepPoller` breaker — pass-through — the poller is unmodified; detect refusals now arrive as `refused:true` and feed the existing breaker via the existing `classifyProgress` branch (they increment `zeroProgressTicks`, not `consecutiveZeroCandidate`).
- New refusal reasons on the sweep (`detect-timeout`/`detect-worker-start-failure`/`detect-index-too-large`/`detect-index-unreadable`/`detect-git-error`) — add — all signal-only, all feed the existing breaker; no new user-facing gate.
- Sweep routing precedence (`resolveSweepFrameworkRouting`) — modify — `freshnessSweep.framework` becomes the effective override **explicit-set-only** (a pre-existing `overrides.CartographerSweep` or an explicitly-set `categories.job` is never overridden); boot-logged.
- `/cartographer/{health,stale,tree,node,navigate,node/refresh}` — modify — serve snapshot / byte-bounded / single-node-read; additive response fields; lazy scaffold removed.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The only new "rejections" are the detect refusal reasons, none of which block a user action — they are signal-only feeds to the sweep breaker (a backoff + degradation, never a hard stop, recovers on the next good tick). The `/tree` (full) route returns `indexState:'too-large-for-request'` above `maxRequestNodes` (default 50000) instead of serving the whole index — a deliberate bound, not an over-block: the data is still reachable via the already-bounded `/cartographer/navigate`, and the response says so. No message/dispatch/outbound block surface is touched.

---

## 2. Under-block

**What failure modes does this still miss?**

- The inline `/cartographer/node/refresh` route still calls `setSummary` (one 67MB index parse+serialize) on a pathological tree — it is rate-limited (30/min) and agent-initiated, not the sweep, and is out of the six-starver inventory; the durable fix is the deferred index-format rework (sharding/SQLite), filed off #1069.
- `git ls-tree` is buffered at an explicit 64MB rather than streamed; a tree whose `ls-tree` output exceeds 64MB refuses cleanly (`detect-git-error`) rather than streaming — the streaming upgrade is the documented deferred follow-up; the explicit buffer is the floor that stops today's ENOBUFS throw.
- A genuinely too-large tree (over `maxIndexBytes`) leaves detect permanently refusing and the snapshot stale — the **accepted, honest** failure mode: `/health` surfaces `lastDetectStatus` + `snapshotStale`, and recovery is operator action (raise the cap / shard the index), by design.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The heavy work is a pure module (`cartographerDetect.ts`) that runs in a worker (off the loop) or synchronously (rollback) — the bounded logic lives once, in the right place, and is unit-testable in-process. The routes became thin snapshot/byte-bounded readers (the request thread should never compute, only serve). The boot scaffold lives off any request handler. The lint enforces the invariant structurally rather than by review. The schema fields were promoted onto the index (the layer detect actually reads) rather than re-derived. No logic was duplicated: the rollback path and the worker share the same module; the snapshot type is defined once and read by both `CartographerTree` (route) and the engine (write).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

The detect refusals are signals into the existing `CartographerSweepPoller` breaker, which is itself signal-only (it backs off cadence + emits a degradation + re-escalates; it never permanently disables the feature or blocks a user action, and recovers on the next successful tick). No new blocking authority is introduced. The lint is a build-time guard, not a runtime authority. The routes' `too-large-for-request` / `not-built` / snapshot-`absent` states are honest read responses, not gates.

---

## 5. Interactions

- **Shadowing:** The lazy scaffold preamble was removed from all `/cartographer/*` routes; nothing downstream relied on the routes building the index (verified: the CI ratchet `scripts/cartographer-freshness.mjs` re-derives staleness from git directly and never reads the snapshot/routes). The boot scaffold builds it instead.
- **Double-fire:** Engine-level single-flight (`inflight`) plus the poller's existing reentrancy guard ensure at most one detect worker alive at a time; the boot scaffold is gated on the index not already existing.
- **Races:** The two-writer race (defer-increment write vs author-summary write) is resolved by single-writer ordering within a pass (lease + single-flight make detect-phase write (a) and author-phase write (b) strictly sequential). Node files (small) are written on the main thread, bounded to `maxNodesPerPass`; a failed batched index write fails soft (node files are momentarily ahead; the next detect re-derives from git and re-converges).
- **Feedback loops:** None. The snapshot is read-only state; detect re-derives from git each pass, so a stale/partial snapshot self-heals on the next tick.

---

## 6. External surfaces

- **Other agents/users (fleet):** New `freshnessSweep` config fields backfill via `applyDefaults` (additive, existence-checked). `.instar/cartographer/` is now gitignored (init + repo + migrator) so the 67MB index/snapshot stop being committable. `migrateClaudeMd` adds one idempotent section. The boot scaffold now runs once at boot for any agent with `cartographer.enabled` and no index — matching the prior build-once behavior (the old routes only scaffolded when no index existed), just moved off the request path.
- **HTTP route shapes:** `/health` + `/stale` gain additive snapshot-provenance fields (`snapshot`, `snapshotStale`, `headSha`, `lastDetectStatus`, `generatedAt`, plus `/stale`'s `total`/`truncated`); legacy field names/semantics (`nodeCount`, `authoredCount`, `staleCount`, `freshness.*`, `count`, `nodes`) are preserved. `/tree` (full) gains an `indexState` ceiling branch. No dashboard consumer of these routes exists (verified).
- **Persistent state:** new per-host `snapshot.json` under `.instar/cartographer/` (gitignored, mode 0600, per-host tmp suffix); index entries gain optional fields (a v1 index parses unchanged — no rewrite migration, no loader version-gate).
- **Timing:** the `/health` + `/stale` numbers are now last-known (age-stamped) rather than always-live — a deliberate "never freeze the server" trade, disclosed on the route via `snapshotStale`/`ageMs`.

---

## 7. Rollback cost

Pure code change at the feature level; revert and ship a patch. No data migration needed to back out: the new optional index fields are ignored by old code (they coalesce), and the snapshot file is gitignored disposable per-host state. Two in-product rollback levers ship with the change: `freshnessSweep.detectInWorker:false` (run the bounded detect synchronously if the worker misbehaves) and `freshnessSweep.enabled:false` (the master kill-switch — the sweep was already shipped OFF, so the blast radius today is only agents that explicitly enabled it). No user-visible regression during a rollback window: the routes degrade to `absent`/`not-built` honestly rather than erroring.

---

## Conclusion

The review produced no design changes beyond what the spec convergence already folded in; it confirmed the invariant is closed across all six starvers and that the only blocking surface (the sweep breaker) remains signal-only. Two honest residuals are documented (the rate-limited inline-refresh index write; the buffered-not-streamed `git ls-tree`), both out of the #1069 inventory and tracked to the deferred index-format rework. The change is clear to ship pending the second-pass review (required: it touches a breaker, a recovery/boot path, and route shapes).

---

## Second-pass review (if required)

**Reviewer:** independent subagent (general-purpose, adversarial read of artifact + code)
**Independent read of the artifact: concern raised → resolved**

The reviewer raised two material concerns and one nit; all were addressed before commit:

- **CONCERN (resolved): boot-scaffold's final index serialization was a synchronous 67MB `JSON.stringify` on the main loop.** `scaffoldChunked` yielded during the walk + node-file writes but its final `buildIndex(nodes)` did one unbroken serialize — violating the boot half of the invariant. **Fix:** `scaffoldChunked` Pass 3 now STREAMS the index to a tmp file incrementally (bounded per-`chunkNodes`, yielding between chunks) and atomic-renames; no single full-index `JSON.stringify` on the loop. (`src/core/CartographerTree.ts` Pass 3.)
- **CONCERN (resolved): the promised boot-scaffold lag test was missing.** **Fix:** added `tests/integration/cartographer-eventloop-worker.test.ts` → "boot scaffold (scaffoldChunked) does NOT starve the event loop on a large real tree (lag < 250ms)" (generates ~6000 real files, samples setInterval drift during `scaffoldChunked`, asserts max lag < 250ms + a readable index ≥ 6000 nodes).
- **NIT (resolved): worker heap not co-sized to let a near-byte-guard index parse.** **Fix:** `detectWorkerHeapMb` default raised to 1536 and `maxIndexBytes` lowered to 200MB (200×6 ≈ 1200MB < 1536MB heap) across ConfigDefaults + engine/server fallbacks; comments corrected.

The reviewer independently confirmed sound: the worker env allowlist omits all secrets; the worker's transitive imports drag no secret/server modules; every detect failure sets `refused:true` and feeds the breaker via `zeroProgressTicks`; no `catch` silently falls back to `staleNodes()`/`loadIndex()`; `timeout → await terminate()` reaps the child git; the two off-thread index writes are strictly sequential under single-flight + lease; new optional index fields coalesce with no loader version-gate; the heap ordering keeps peak O(maxCandidates) on cold + stale paths; routes preserve legacy fields additively; the breaker stays signal-only; routing precedence is explicit-set-only and boot-logged.

---

## Evidence pointers

- Spec + convergence report: `docs/specs/CARTOGRAPHER-SWEEP-EVENTLOOP-SAFETY.md`, `docs/specs/reports/cartographer-sweep-eventloop-safety-convergence.md`, ELI16 `docs/specs/cartographer-sweep-eventloop-safety.eli16.md`.
- Unit: `tests/unit/cartographerDetect.test.ts` (bounded/golden-order/zero-node-reads/refusal-taxonomy/secret-filter/defer/applyDeltas), `tests/unit/cartographer-sweep-poller-breaker.test.ts` (refusal→breaker), `tests/unit/cartographer-sweep-routing.test.ts` (framework precedence + claude-floor).
- Integration: `tests/integration/cartographer-eventloop-worker.test.ts` (REAL dist worker; event-loop lag < 250ms on a 60k-entry index; timeout refusal; rollback), `tests/integration/cartographer-routes.test.ts` (snapshot-backed routes, no lazy scaffold).
- E2E: `tests/e2e/cartographer-lifecycle.test.ts`, `tests/e2e/cartographer-freshness-lifecycle.test.ts` (author lifecycle + routes alive via snapshot).
- Lint: `scripts/lint-no-mainthread-cartographer-walk.js` (clean; wired into `npm run lint`).
- Build dist for the dist-backed test: `tests/setup/build-dist.globalSetup.ts` (wired into the integration + e2e vitest configs).
