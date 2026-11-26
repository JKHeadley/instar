# Review round 1 — Gemini 4 Argon (gemini CLI), 2026-10-25

### 1. Verdict

**Ready with changes.** The problem diagnosis and the core mechanics (honest liveness states, durable peer observations, normalized multi-signal load reports, reserved capacity, and OS priority) are strong. However, the spec contains factual mismatches against the current codebase, leaves two silent data-dropping traps open on the heartbeat path, relies on an unwired rebalance planner, and includes three over-engineered pieces that violate Occam's razor.

---

### 2. Factual Errors vs. the Code

1. **`RebalancePlanner` and `TransferOrchestrator` are described as an "existing... path" (§6 D2):** `RebalancePlanner` is completely dead code in production (`src/core/RebalancePlanner.ts:86`: *"DORMANT today — RebalancePlanner is not wired into the server (no live moves)"*). Furthermore, `planRebalance` does not pass `channel` into `placement.decide()` (`src/core/RebalancePlanner.ts:90-96`), which is a tracked bug (`CMT-1568`) that would move Slack/Telegram sessions onto machines disconnected from their workspace.
2. **Why peer `hardware` is null (§1.3, §4 B1):** `MachinePoolRegistry` does not read `os` for peer hardware; it reads `entry.hardware` from `identityManager.getActiveMachines()` (`src/commands/server.ts:20610-20614`), populated at boot by `poolIdMgr.recordSelfHardware()` (`src/commands/server.ts:20683`). A peer's `hardware` is null on other machines when `registry.json` hasn't synced from credential-less/WSL peers or wasn't carried over HTTP `session-status`—not because the local heartbeat omitted `os` calls.
3. **Why peer `load` is null in `GET /pool` (Incident note & §1.3):** `refreshPool` in `src/commands/server.ts:20780` only records `loadAvg` for `poolSelfId`. For peers in `refreshPool` (`src/commands/server.ts:20868`), it records a sparse coarse beat `{ machineId, selfReportedLastSeen, coarseHeartbeat: true }` with **no load fields**. And when that 30s coarse beat runs in `MachinePoolRegistry.recordHeartbeat()` (`src/core/MachinePoolRegistry.ts:252-279`), it overwrites `this.observed.set(obs.machineId, ...)` and **wipes out** `loadAvg` (and any new `LoadReport`) previously pulled by `PeerPresencePuller` (`src/core/PeerPresencePuller.ts:259`), because only `posture`, `coherence`, and `seamlessnessFlags` have carry-forward logic!
4. **`ws44PoolCache` does not poll `/pool` on a background loop (§3 A3):** `PoolPollCache` (`src/server/PoolPollCache.ts:132-193`) is an on-demand, 3s-TTL, single-flight cache for dashboard routes (`/sessions`, `/jobs`, `/attention`, `/guards` with `?scope=pool`), and it ships dark on non-dev agents (`src/commands/server.ts:21125`). The background peer poller is `PeerPresencePuller` (`src/core/PeerPresencePuller.ts:248`, `server.ts:24259`), which calls MeshRpc `session-status`, not `GET /pool`.
5. **`MachineLoadBroker` scope (§4 B2):** `MachineLoadBroker` (`src/core/MachineLoadBroker.ts:1-21`) is an L6 multi-agent-per-machine isolator that checks whether co-resident agents under-report their RSS footprint vs. OS `ps` samples. It has nothing to do with network peer cross-checking.

---

### 3. Most Important Design Flaws & Missing Cases (Ranked)

1. **Coarse git heartbeats and `PeerPresencePuller` narrowing will silently drop `LoadReport` (Critical — Missing Case)**
   - *Flaw:* Two places will erase peer load data: (a) `PeerPresencePuller.narrowSessionStatusToPeerCapacity()` (`src/core/PeerPresencePuller.ts:132-177`) has an explicit allowlist of fields (`SESSION_STATUS_ADVERT_FIELDS`) and drops everything else—a bug class already hit 5 times in this file; (b) `refreshPool`'s 30s coarse git-heartbeat loop (`server.ts:20868`) overwrites `this.observed` in `MachinePoolRegistry.recordHeartbeat()`, wiping out HTTP-pulled load fields every 30s.
   - *Fix:* Add `loadReport` (and `hardware`) to `SESSION_STATUS_ADVERT_FIELDS` and `narrowSessionStatusToPeerCapacity()`, and store `loadReport` in a separate receipt-stamped slot on `MachinePoolRegistry.observed` (identical to `posture` and `coherence` at `MachinePoolRegistry.ts:201-211`) so sparse coarse beats never erase live HTTP reports.
2. **Synchronous `spawnSync('vm_stat')` on the heartbeat path causes event-loop lag (High — Design Flaw)**
   - *Flaw:* §4 B1 puts `HostPressureSampler` / `hostMemoryPressure` on every 30s heartbeat. On macOS, `readSystemMemoryPressure()` (`src/monitoring/hostMemoryPressure.ts:89`) runs `spawnSync('vm_stat', ..., { timeout: 5000 })`, blocking the main thread and inflating the exact `WriteAdmission` `monitorEventLoopDelay` p99 gauge (`src/core/WriteAdmission.ts:288`) used to diagnose `starved`!
   - *Fix:* Sample CPU idle (`os.cpus()` delta across ticks) and memory asynchronously off the heartbeat path (or via async `execFile('vm_stat')`), caching the latest reading in memory for `refreshPool` and `session-status` to read synchronously in $O(1)$.
3. **Unwired `RebalancePlanner` + missing `channel` scope will black-hole moved sessions (High — Missing Case)**
   - *Flaw:* §6 D2 assumes `RebalancePlanner` → `TransferOrchestrator` is wired and safe. Activating it as-is will hit `CMT-1568` (`src/core/RebalancePlanner.ts:83-96`), moving topics to machines that lack the channel/workspace adapter, and bypassing `OwnershipReconciler` (`src/commands/server.ts:21370`), which is the actual live move engine in the server.
   - *Fix:* Plumb `channel` into `RebalanceSession` and `placement.decide()`, and execute overload moves as advisory move-intents through the existing `OwnershipReconciler` loop (which already enforces `sustainedOnline`, `isTopicBusy`, `hasLiveAutonomousRun`, and `ws13MaxMovesPerTick`).
4. **Over-engineering: LLM Warden Session (§5 C3) & Jev Model Assessment (§4 B4) (Medium — Occam / 80/20)**
   - *Flaw:* Spawning a Claude/LLM "warden session" (§5 C3) on a machine that is already `saturated` consumes hundreds of MB of RSS, spawns subprocesses, and adds API latency just to run `load-assess.sh`, offload idle MCP servers, and request topic moves. Similarly, calling an LLM (Jev → GPT-6 Luna, §4 B4) to adjudicate 6 numeric metrics is unnecessary complexity.
   - *Fix:* Cut both from v1. Make MCP idle-offload, `acceptingWork: false`, and attention-raising **deterministic TypeScript functions** triggered directly by the `saturated` verdict. Reserve the `maxSessions - 1` slot strictly for operator-initiated emergency sessions.
5. **Cold-boot placement deadlock when all peers are `unknown` (Medium — Missing Case)**
   - *Flaw:* §4 B3 makes `unknown` or `stale` load *ineligible for new placement*. On server restart, before the first `PeerPresencePuller` pass completes (or if self-sampling hasn't completed 1 tick), every machine is `unknown`, causing `PlacementExecutor` to queue/block all incoming messages.
   - *Fix:* Initialize local `LoadReport` synchronously at boot before `refreshPool()`, and in `PlacementExecutor` rank `live + ok/elevated` above `unknown`, using `unknown` only as a last-resort fallback (matching the `yes`-over-`unknown` pattern in `machineServesChannel` at `src/core/PlacementExecutor.ts:183`).

---

### 4. Answers to Section 8 Open Questions

1. **OS priority (C2) vs. separate responder process in v1?**
   OS priority (`nice +5` on child processes) **plus** fixing synchronous blocking calls on the server's main event loop (like `spawnSync('vm_stat')`) is enough for v1. When Node.js fails to answer `/pool` in 15s, it is almost always event-loop starvation or swap thrash, not kernel CPU scheduling preempting a sub-millisecond HTTP handler. Defer the separate process.
2. **Are `saturated` thresholds and the two-family rule right?**
   **No—the two-family rule is too strict for single-resource exhaustion.** A machine with `eventLoopLag p99 = 1500ms` (below the 2s `starved` bar) and 50% CPU idle (8 cores, 1 wedged main thread) is severely impaired for mesh RPCs, and a machine in swap thrash with low CPU is unusable. *Fix:* Trigger `saturated` if **any single signal is at its critical ceiling** (e.g., `memPressure === 'critical'`, `eventLoopLag p99 > 1000ms`, or `activeSessions >= maxSessions - 1`) **OR** two elevated signals agree.
3. **Should peer-observed evidence (A3) feed placement, or display only?**
   **Display only** (plus suppressing false "offline" wording). Allowing gossiped `peer:<id>` capacity into `PlacementExecutor` breaks the single-hop clock-skew invariant in `MachinePoolRegistry.ts:10-15` and risks routing a session to a peer that the router itself cannot reach (asymmetric network partition). However, instead of polling `/pool` via `ws44PoolCache`, piggyback peer observations on `PeerPresencePuller` (`capacity-report` or `session-status`).
4. **Is the warden session (C3) worth its cost vs. deterministic shedding alone?**
   **No.** Deterministic shedding + deterministic idle-MCP reaping + a deterministic top-process snapshot (`ps` top 5 CPU/RSS attached to the attention item) gives 95% of the value at 0% of the memory/CPU risk during an overload crisis. Keep the reserved slot for human operator intervention.
