---
title: "Cartographer Sweep Event-Loop Safety — off-thread detect, bounded candidates, honored framework field (fix #1069)"
slug: "cartographer-sweep-eventloop-safety"
author: "echo"
---

# Cartographer Sweep Event-Loop Safety (fix instar#1069)

## Problem statement

Enabling the doc-freshness sweep on echo's real tree (366,757 nodes; `index.json` is **67MB** on disk) put the AgentServer into a supervisor kill-loop: two consecutive server deaths, each ~10–15 min after boot, exactly when the sweep's first tick fired. The SleepWakeDetector logged repeated ~33–38s event-loop starvation bursts; `/health` never answered; the lifeline supervisor (correctly, per its contract) killed the server after 6 consecutive failed checks. Zero authoring calls ever completed — `feature-metrics.db` has no `CartographerSweep` rows, so the process died in the *detect* phase, before any LLM call.

The starver is the detect phase of `CartographerSweepEngine.runPass()`, which runs entirely on the server's main event loop:

1. `CartographerTree.loadIndex()` — synchronous `fs.readFileSync` + `JSON.parse` of the 67MB index file, re-read on every call, no cache (`src/core/CartographerTree.ts:375`).
2. `CartographerTree.currentOids()` — one batched but **synchronous, fully-buffered** `git ls-tree -r -t -z HEAD` over the whole tracked tree, then a 366k-entry parse loop (`src/core/CartographerTree.ts:185`).
3. `CartographerTree.staleNodes()` — a 366k-iteration compare loop that **materializes the full non-fresh set** (`src/core/CartographerTree.ts:546`). On a tree with `authoredCount: 0`, every node is `never-authored`, so the materialized array is all 366,757 entries — yet the engine only needs `maxNodesPerPass` (25) candidates plus counts.

Same-family exposures (synchronous full-tree walks on the server main thread, outside the sweep tick):

- `CartographerTree.health()` computes `staleCount` via a full `staleNodes()` walk — and it backs the `GET /cartographer/health` HTTP route.
- `GET /cartographer/stale` materializes and serializes the full stale set on the request path.
- The boot-time index build (`scaffold()`) hangs HTTP routes for ~2 min after boot on this tree (observed during the incident).

**Secondary finding (routing trap):** `cartographer.freshnessSweep.framework` ("codex-cli") is *decorative*. `probeRouting()` resolves via `router.for('CartographerSweep')` (overrides → categories[job] → default) and never reads the config field. With only `categories.sentinel` routed, the sweep resolved to default claude-code and refused every pass — which *masked* the starvation bug (the refusal returned before `staleNodes()` ran, so the first enable looked stable). A config field that looks authoritative but is ignored is a trap; the incident workaround on echo was a manual `sessions.componentFrameworks.overrides.CartographerSweep = "codex-cli"`.

The invariant this spec exists to establish: **a background freshness job must never be able to take the server down, no matter how large the tree.**

## Proposed design

### Slice 1 — Detect runs off the event loop (worker thread)

A dedicated short-lived `worker_threads` worker (`src/core/cartographerDetect.worker.ts`, first worker in the codebase — no existing precedent) performs the entire detect phase:

- Reads + parses `index.json` (the 67MB parse happens off-loop).
- Runs `git ls-tree -r -t -z HEAD` and derives per-node staleness status (the same `deriveStatus` logic, extracted to a shared pure module so worker and main thread cannot drift).
- Applies the engine's existing candidate-ordering rules (deepest-first, dir-defer, anti-starvation) **inside the worker**.
- Returns a **bounded payload only**: up to `maxNodesPerPass × deferHeadroomFactor` ordered candidates plus aggregate counts `{ nodeCount, authoredCount, neverAuthored, stale, pathGone, generatedAt, headSha }`. The full materialized stale set never crosses the worker boundary and never exists on the main thread.

`CartographerSweepEngine.runPass()` awaits `detectCandidates()` instead of calling `tree.staleNodes()` inline. Spawn-per-detect (no persistent worker): the cadence (10 min) makes spawn cost irrelevant, and a worker that exits after returning a small payload cannot leak memory across ticks.

**Detect watchdog:** the await is bounded by a wall-clock timeout (config `freshnessSweep.detectTimeoutMs`, default 120000). On timeout: `worker.terminate()`, the pass aborts as a refusal (`reason: 'detect-timeout'`), it counts as a zero-progress tick feeding the **existing** poller breaker, and one bounded degradation is emitted via the existing `reportDegradation` path. A background freshness job that cannot finish detect backs off and tells someone — it never keeps grinding.

**No silent main-thread fallback:** if worker startup fails (bundling regression, resource exhaustion), the pass refuses with a named reason. It must never quietly fall back to the synchronous full walk — that would resurrect the kill-loop exactly when the system is least healthy.

### Slice 2 — Hot HTTP paths serve a snapshot, never a walk

Each successful detect persists its aggregate counts + a bounded stale sample to a small snapshot file (`.instar/cartographer/freshness-snapshot.json`, atomic write via the existing tmp+rename pattern). Then:

- `GET /cartographer/health` serves freshness counts **from the snapshot** (stamped with `generatedAt` + `headSha` so staleness of the snapshot itself is honest), falling back to `null` counts + `snapshot: 'absent'` when no detect has run — never a synchronous 366k walk on the request path.
- `GET /cartographer/stale` serves from the snapshot's bounded sample with an explicit `truncated: true` marker and the total count — never the full materialized set.
- `CartographerTree.staleNodes()` remains for small trees and tests but gains a doc-comment contract: O(nodeCount) synchronous — callers on the server hot path are forbidden (enforced by the lint below if feasible, otherwise by review).

### Slice 3 — `freshnessSweep.framework` is honored (the trap is removed)

The config field feeds routing instead of being ignored: at engine construction, `freshnessSweep.framework` (when set) is applied as a component-level routing override for `CartographerSweep`. Precedence: explicit `sessions.componentFrameworks.overrides.CartographerSweep` → `cartographer.freshnessSweep.framework` → `categories` → default. The existing probe semantics are unchanged (still refuses to author on the default/Claude framework unless `allowClaudeFallback`). Echo's incident-time manual override becomes unnecessary but stays harmless (it simply wins precedence).

### Slice 4 — The invariant gets a test, not a hope

- **Unit:** detect on a generated large-tree fixture (≥50k nodes, synthetic index) returns bounded payloads; ordering rules match the previous inline implementation on a shared fixture (drift test); timeout path terminates the worker and refuses the pass; worker-startup-failure path refuses with the named reason.
- **Integration:** an event-loop-lag harness — `setInterval` drift sampled on the main thread while a detect runs against the large fixture — asserts max observed lag stays under a bound (e.g. 250ms) for the whole pass. This is the test that fails if anyone ever reintroduces a synchronous full walk on the sweep path.
- **E2E:** feature-alive test extended — sweep enabled on the e2e fixture authors through the worker path end-to-end; `/cartographer/health` and `/cartographer/stale` answer from the snapshot.

### Out of scope (explicitly deferred, tracked)

- **Boot-time `scaffold()` starvation** — same family, different writer-safety profile (scaffold writes 65k+ node files; moving writes off-thread interacts with the single-in-process-writer invariant). Deferred to a follow-up issue filed at merge time, referenced from #1069.
- **Index storage format** (67MB monolithic JSON) — the worker makes the parse cost harmless to the event loop; sharding/SQLite is a separate cost-benefit decision.

## Decision points touched

- New refusal path on the sweep (detect-timeout / worker-start-failure) — feeds the existing breaker; no new user-facing gates.
- Routing precedence change for the `CartographerSweep` component (Slice 3). No other component's routing is affected.
- `GET /cartographer/health` + `GET /cartographer/stale` response shapes gain snapshot provenance fields; existing consumers (CI ratchet, dashboard) must be audited for compatibility.

## Open questions

1. **Snapshot-backed CI ratchet compatibility:** the doc-freshness CI ratchet reads health counts — does it tolerate `snapshot: 'absent'` on a tree where no detect has run yet, or does it need its own direct (CI-side, off-server) computation?
2. **Lint enforceability of "no `staleNodes()` on server hot paths":** is there a reasonable structural guard (import-boundary lint), or does this stay a documented contract?
3. **Detect timeout default:** 120s is generous for a 67MB parse + full ls-tree on this machine, but slow disks/giant monorepos may need more — should the timeout self-report measured detect duration so operators can tune from data?
