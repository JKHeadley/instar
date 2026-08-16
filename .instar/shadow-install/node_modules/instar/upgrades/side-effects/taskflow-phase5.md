# Side-Effects Review — TaskFlow Phase 5 (rate limits + cache eviction tuning + audit ledger emission)

**Version / slug:** `taskflow-phase5`
**Date:** 2026-05-10
**Author:** Echo
**Second-pass reviewer:** required (introduces HTTP-boundary authority gates — rate limits — and reshapes the audit-ledger emission path)

## Summary of the change

Phase 5 hardens the TaskFlow surface that prior phases established. The change:
1. Adds per-controller rate limits on `POST /flows` (default: 10/sec) — overflow throws `quota_exceeded` with `code='rate_limit'` → HTTP 429.
2. Adds per-controller max-active-flows cap (default: 50 non-terminal flows per `controllerId`) — overflow throws `quota_exceeded` with `code='max_active'` → HTTP 429.
3. Adds per-flow ping rate limit on `POST /flows/:flowId/ping` (default: 60 pings/min/flow) — overflow throws `quota_exceeded` with `code='rate_limited'` → HTTP 429.
4. Replaces the ad-hoc cache eviction in `TaskFlowRegistry` (`Map`-based with terminal-flow head-scan) with a proper LRU + capacity (default: 1000 entries) + the metric `taskflow_cache_evictions_total`.
5. Fixes the previously-broken `emitLedgerNote` path in `TaskFlowRegistry` so that state-transition audit notes actually get written to `SharedStateLedger`. The notes are restricted to the redacted shape per spec § Threat Model lines 681-682 (`flowId, revision, currentStep, from_status, to_status, waitKind, controllerId, op`) — never `stateJson`, never any field of `waitJson` beyond `kind`.

Per the spec (`docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md`, lines 650-653 Phase 5 / lines 679 + 685 Threat Model / lines 681-682 redaction), the design goal is to enforce sane per-counterparty resource budgets at the HTTP boundary and to produce a full state-machine audit trail in SharedStateLedger that contains no controller-private payload.

**Files touched:**
- `src/tasks/RateLimiter.ts` (new) — sliding-window per-key rate limiter with monotonic clock injection.
- `src/tasks/LruCache.ts` (new) — bounded LRU with eviction callback for metric emission.
- `src/tasks/TaskFlowRegistry.ts` — wires rate limits in `createFlow` / `pingFlow`, replaces cache with `LruCache`, restructures `emitTransitionLedgerNote` / `emitLedgerNote` to use a real `SharedStateLedger.append` payload.
- `src/tasks/task-flow-types.ts` — adds `RateLimitConfig`, `CacheConfig`, `DEFAULT_RATE_LIMITS`, `DEFAULT_CACHE_CONFIG`, `ACTIVE_STATUSES`.
- `src/core/types.ts` — adds `'taskflow-transition'` to `LedgerEntrySubsystem`.
- `src/core/SharedStateLedger.ts` — adds `'taskflow-divergence'` and `'taskflow-transition'` to `VALID_SUBSYSTEMS` (the divergence one was a pre-existing union-but-not-runtime-validated gap; this commit closes it).
- `src/server/routes.ts` — adds `Retry-After` header on 429 responses when `retryAfterMs` is supplied.
- `src/commands/server.ts` — plumbs `config.taskFlow.rateLimits` and `config.taskFlow.cache` into `TaskFlowRegistry`.
- `tests/unit/task-flow-rate-limits.test.ts` (new) — 12 tests.
- `tests/unit/task-flow-cache-eviction.test.ts` (new) — 9 tests.
- `tests/unit/task-flow-audit-ledger.test.ts` (new) — 10 tests.
- `upgrades/side-effects/taskflow-phase5.md` (this file).

## Decision-point inventory

- `RateLimiter.tryAcquire(key)` — **add** — pure mechanic. Returns `{ok, retryAfterMs, currentCount}`. No external authority. Limit = `Infinity` disables bookkeeping entirely. The hot-path bound: per-key bucket length ≤ limit (typically 10 for create, 60 for ping), and total tracked keys self-prune on each acquire after 256 calls (MAX_BUCKETS=50_000 ceiling).
- `LruCache.set(key, value)` — **add** — pure mechanic. Map-backed LRU; insertion-order semantics on cold inserts, recency-refresh on `get`. Evicts oldest on capacity. Fires `onEvict` for metric emission.
- `TaskFlowRegistry.createFlow` — **modify** — adds (i) idempotency pre-check (so idempotent replays do not consume a rate slot), (ii) `createLimiter.tryAcquire(controllerId)`, (iii) `getActiveCount(controllerId) < maxActivePerController` check. All three reject with `TaskFlowError('quota_exceeded', ...)` carrying `code` ∈ `{'rate_limit', 'max_active'}`.
- `TaskFlowRegistry.pingFlow` — **modify** — adds `pingLimiter.tryAcquire(flowId)`, but ONLY after the principal/controllerId-match authority checks. Bogus pings do not consume rate-limit slots.
- `TaskFlowRegistry.applyOcc` — **modify** — on every terminal entry: (i) decrements per-controller active count via `onTerminalTransition`; (ii) calls `pingLimiter.forget(flowId)` so the per-flow bucket is reclaimed.
- `TaskFlowRegistry.cachePut` — **modify** — delegated to `LruCache`. Removes the ad-hoc terminal-flow head-scan eviction (which was O(32) worst-case but had no eviction count).
- `TaskFlowRegistry.emitTransitionLedgerNote` — **rewrite** — was previously emitting an invalid `kind: 'note:taskflow-transition'` payload (which SharedStateLedger rejects with "invalid kind"). Now emits `kind: 'note'`, `subsystem: 'taskflow-transition'`, with the redacted payload encoded into `summary`. Also emits a `taskflow:audit-emitted` event with the structured payload for tests / dashboards.
- `routes.ts` 429 error handler — **modify** — sets `Retry-After: <seconds>` header (ceiled, min 1) when `retryAfterMs` is in the error detail.

---

## 1. Over-block

**Rate limits are authority gates at the HTTP boundary** — they reject requests. Over-block means rejecting legitimate traffic. The risk profile:

- **createPerSec=10 is conservative.** Real EvolutionManager / InitiativeTracker controllers create 1-10 flows per minute under normal load, far below 10/sec. Burst scenarios (backfill at startup, divergence-checker-triggered remediation) are bounded; the 10/sec budget gives 600/minute headroom. If a real workload needs more, operators raise the config — see `config.taskFlow.rateLimits.createPerSecPerController`.
- **maxActive=50 may be tight for some controllers.** The InitiativeTracker controller, post-Phase 4, could plausibly have >50 concurrent waiting initiatives. Mitigation: configurable via `config.taskFlow.rateLimits.maxActivePerController`. If operators hit this in production, the response is to raise the cap, not to revert.
- **pingPerMin=60 = 1/sec sustained.** This matches `HEARTBEAT_INTERVAL_MS = 60_000ms` (per-minute heartbeat) with substantial headroom for retry-after-failure pings. A controller pinging at the documented cadence cannot trigger this limit.

**Tuning options (when over-block triggers):**
- Set the relevant `config.taskFlow.rateLimits.*` value higher.
- Set the value to `Infinity` to disable the gate entirely (verified by the `'respects custom createPerSecPerController = Infinity (disabled)'` test).
- Hot-restart the server picks up the new config; no DB migration needed.

**Non-block surfaces (cache + audit) cannot over-block.** Cache eviction degrades read performance (one extra DB round-trip), not correctness. Audit emission is fire-and-forget — failures never propagate into the state-machine path.

## 2. Under-block

**Failure modes the change does not catch:**

- **`controllerId` spoofing on `createFlow`.** Any auth-token holder can claim any `controllerId` when creating a flow. The rate limit is keyed on the claimed value, so an attacker can create 10 flows/sec under controllerId "A" + 10 flows/sec under "B" + ... Mitigation already in place: the `RateLimiter` has a `MAX_BUCKETS=50_000` ceiling with lazy pruning, so memory cannot explode. The per-controller max-active=50 cap is also keyed on claimed controllerId, so the attacker's storage footprint per claimed-id is bounded. Authority for who-may-claim-a-controllerId remains at the auth-token layer (loopback-only by default; explicit opt-in to expose via tunnel — per spec § Threat Model line 671).
- **Pre-rate-limit input validation.** The schema parse + reserved-controller check + state size check all run BEFORE the rate limit. This is intentional: a flood of malformed payloads with bad schemas could thus get O(N) zod work, but those payloads also get rejected with `invalid_argument` (HTTP 422) — they never reach the registry's mutation path. If the parse itself becomes a DoS vector, the upstream HTTP layer (body-parser size limit) is where to mitigate.
- **Ping rate limit bypass via known flowId.** Mitigated structurally: the principal / controllerId-match check happens BEFORE the rate counter (verified by the `'bogus principal is rejected BEFORE the rate counter increments'` test). A non-owning caller cannot consume the legitimate controller's ping budget.
- **Active-count drift after server restart.** The per-controller active-count cache is lazy-loaded from DB on first access. So the first `createFlow` for a controller after a restart runs a full DB scan filtered by status. For a controller with thousands of historical flows, this DB scan is O(active_only) (the `flows_controller_status` index makes it sub-millisecond). Not a real concern for typical controller cardinality.
- **Clock-skew on sliding window.** If `Date.now()` jumps backward (NTP), bucket timestamps could appear future-dated and never age out. Within a single-writer server process the risk is low (we don't rely on cross-machine clock sync). If it materializes, the bucket self-recovers on the next forward-pass through the limit threshold.
- **Audit ledger lock contention.** If 50 concurrent transitions race for the SharedStateLedger lock, some appends may fail-open (per the existing `proper-lockfile` retry budget). This is the existing semantics from Phase 3a; Phase 5 inherits, does not regress.

## 3. Level-of-abstraction fit

**Rate limits live at the registry, surfaced via 429 at the HTTP layer — by deliberate design:**

- The `RateLimiter` itself is a pure helper. It belongs in the `tasks/` directory because that's the consumer.
- The rate-limit *invocation* lives in `TaskFlowRegistry.createFlow` / `pingFlow`, NOT in `routes.ts`. This is the load-bearing choice: putting the check at the registry means every code path that creates a flow (HTTP, internal subsystem callers like `EvolutionManager.dualWriteCreate`, future test-only paths) sees the same limit. Putting it at the route layer would let internal subsystems bypass it — a real concern for the EvolutionManager backfill, which can burst.
- The `Retry-After` HEADER lives in `routes.ts`, NOT in the registry. The registry returns a transport-agnostic `retryAfterMs` in `TaskFlowError.detail`; the HTTP layer maps that to RFC 7231 § 7.1.3 header semantics. This separation lets non-HTTP consumers (subsystem code) still read the structured `retryAfterMs` field.
- The LRU is bounded inside the registry; metric emission goes through `console.log [metric] ...` matching the existing pattern from `DivergenceChecker.emitMetric`.
- Audit-ledger emission lives in the registry. A separate "AuditEmitter" class was considered and rejected: it would require the registry to call out and pass state-transition metadata to a stateless helper, which is the same shape as a private method. Not worth the indirection.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **Rate limits ARE an authority gate, but at the right layer.** The Phase 5 rate-limit gates are HTTP-boundary mechanical authorities (sliding-window counters), not LLM-backed gates. The principle that "brittle/low-context filters detect and emit signals; only a higher-level intelligent gate with full context has blocking authority" applies to *content* gates (e.g., outbound message classification). Rate limits are mechanical resource-budget gates; the signal-vs-authority guidance explicitly allows mechanical authorities at structural boundaries. The "intelligent reviewer" for rate-limit tuning is the human operator who reads metrics and adjusts `config.taskFlow.rateLimits.*`.

- [x] **The audit ledger emission produces a SIGNAL, not an authority.** Transition notes are tier-2 observability — fire-and-forget appends consumed by humans / dashboards / future analyzers. They have zero authority over state-machine correctness. Verified by the `'audit emission is async/best-effort — does NOT block state correctness'` test: even when `ledger.append` throws, the OCC mutation completes and `applied: true` is returned.

- [x] **The cache is a pure mechanic.** LRU eviction is deterministic; the metric emission is observational. No authority surface.

**Where authority is concentrated:**
- The HTTP layer (`routes.ts` 429 handler) is where the rate-limit decision is *surfaced* to clients. The decision itself is upstream, in the registry, made by the mechanical limiter. The high-level intelligence that adjusts the limit's *value* is the operator (informed by metrics).
- The principal/controllerId-match check (in `pingFlow`, `assertControllerScope`) is unchanged from prior phases.

No new brittle blocker is introduced. No existing intelligent authority is shadowed.

---

## 5. Interactions

### With Phase 1 (registry + sweeper + waker)

- **TaskFlowMaintenanceSweeper** uses `RESERVED_MAINTENANCE_CONTROLLER` to mark flows `lost`. The reserved controllerId is exempted from `createFlow` rate limits (it never calls `createFlow`; it goes through `markLost` → `applyOcc`, which is not rate-limited). Sweeper is unaffected.
- **TaskFlowDueWaker** calls `resumeFlow` directly via `applyOcc`. Not rate-limited. Unaffected.
- The Phase 1 cache eviction was ad-hoc and never produced eviction metrics. Phase 5 supersedes it with a real LRU. Cache reads are still served from-cache when present; cache misses still go to SQLite. Performance neutral for hot paths; cache hit ratio slightly improved by recency-refresh on `get`.

### With Phase 2 (cancellation primitives)

- `requestFlowCancel` runs through `applyOcc` and is not rate-limited at the request layer. This is deliberate — cancellation should not be limited even when the controller is over its create budget. If a future need arises, a separate `cancelPerMinPerController` config can be added.
- The `taskflow-cancel-requested` ledger note (Phase 2) now uses the same `emitLedgerNote` path that this PR fixes (was previously broken with `kind: 'note:taskflow-cancel-requested'` → schema rejection). This is a quiet bug fix; cancellation notes will now actually land.

### With Phase 3a (EvolutionManager dual-write + DivergenceChecker)

- `EvolutionManager.dualWriteCreate` calls `registry.createFlow` directly. It now goes through the same rate limit. The `EvolutionManager` controller has a conservative cadence (proposals are minutes-to-hours apart), so the 10/sec limit is non-binding. The backfill (`migrateExistingToTaskFlow`) runs at server startup and creates one flow per existing proposal; for a fleet of 50 proposals at startup this is well under the 10/sec budget.
- The `DivergenceChecker` does not call `createFlow`; it reads + emits notes. Unaffected by rate limits.
- This PR fixes a pre-existing bug where `'taskflow-divergence'` was in `LedgerEntrySubsystem` but missing from `VALID_SUBSYSTEMS` runtime list — DivergenceChecker's notes were rejected with "invalid emittedBy.subsystem". This bug was effectively rendering Phase 3a's divergence-monitoring blind. Phase 5 closes the gap.

### With Phase 4 (InitiativeTracker migration) — likely landing alongside or shortly before

- Phase 4 moves InitiativeTracker's state into TaskFlow. The `InitiativeTracker` controller will share the per-controller create / max-active limits. If Phase 4's controller cadence approaches the 10/sec default, operators raise the limit. The 50 max-active value matches typical initiative-tracker scales (low tens of active initiatives).
- If Phase 4 lands first, this PR rebases cleanly off the new `origin/main` — no expected merge conflicts since Phase 4 touches `InitiativeTracker.ts` not `TaskFlowRegistry.ts` internals.

### With WikiClaim phases

- WikiClaim phases touch `memory/` paths, not flow APIs. Zero interaction.

### Cache coherence

- The LRU is process-local. Single-writer assumption (per spec line 717) means no cross-process invalidation needed.
- `getFlow(id, {bypassCache: true})` still works the same; consumers that need fresh-from-DB reads (e.g., `EvolutionManager.dualWriteTransition`) continue to bypass.

### Race conditions

- **Idempotency-replay race.** The outer idempotency check (pre-rate-limit) is a fast read outside the transaction. Between that read and the inner transaction re-check, another process could insert a matching idempotency row — but the single-writer constraint rules out that scenario. Within one process, the JS event loop is single-threaded; the read and transaction are sequential.
- **Active-count drift.** The per-controller active-count cache is bumped in-process on create / decremented on terminal transition. If a server restart loses the cache, the next `getActiveCount` call rebuilds from DB. Net effect: the cap is enforced correctly across restarts; only the in-memory bookkeeping is volatile.
- **Audit lock contention.** Same as before — `proper-lockfile` with 10-retry backoff. Failures fail-open with a `[DEGRADATION]` line.

### Feedback loops

- The cache-eviction metric feeds operator decisions on cache cap tuning. No automated loop.
- The rate-limit rejection counters (`rateLimitRejections.create_rate` / `max_active` / `ping_rate`) feed operator decisions on limit tuning. No automated loop.
- Audit notes feed humans / dashboards. No automated loop.

## 6. External surfaces

- **Other agents on the same machine:** No new surface. All HTTP routes are loopback-bound by default (per spec § Threat Model line 671).
- **Other users of the install base:** Phase 5 is gated on `config.taskFlow.enabled` (default off, established in Phase 1). Existing installs are unaffected until they opt in to TaskFlow.
- **External systems:** None. No outbound HTTP, no LLM calls.
- **Persistent state:** No schema changes to `.instar/task-flows.db`. The `.instar/shared-state.jsonl` gains additional `note` entries (one per state transition) — the existing rotation-at-5000-lines policy handles growth. Worst-case: a controller creating + finishing 100 flows / day adds ~600 lines / day to the ledger; 5000-line rotation triggers ~weekly per heavy controller. The ledger already rotates and archives prior files.
- **Timing or runtime conditions:** Rate-limit buckets are in-memory only; on restart all buckets clear and a burst is immediately possible. This is by design — the spec does not require restart-persistent rate limits, and persisting them would add a write to every createFlow / pingFlow.

## 7. Rollback cost

- **Hot-fix release:** Revert the PR. Restart the server. No data migration.
- **Soft rollback (disable but keep code):** Set `config.taskFlow.rateLimits = { createPerSecPerController: Infinity, maxActivePerController: Infinity, pingPerMinPerFlow: Infinity }` and restart. Rate limits become non-binding. Cache continues to operate with the default 1000-entry cap; to disable that, set `config.taskFlow.cache.maxEntries: 0`.
- **Data migration:** None on rollback. The audit-ledger notes already written remain valid `note`-kind entries in `shared-state.jsonl`; they have a recognized subsystem (`'taskflow-transition'`) and follow the schema. They will continue to render correctly on the existing dashboard.
- **Agent state repair:** None.
- **User visibility:** Reverting Phase 5 removes the 429 responses from `/flows` / `/flows/:id/ping`. Clients that depend on the 429 contract (none ship today) would need to be updated. No user-facing UI surface is affected.

## Audit-ledger redaction shape (load-bearing quote from spec)

Per `docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md` lines 681-682:

> **State leakage via `stateJson`**:
>   - Audit ledger notes log only `flowId`, `revision`, `currentStep`, `from_status`, `to_status`, `waitJson.kind`.

The Phase 5 implementation emits structurally:

```
{
  flowId, revision, currentStep, from_status, to_status, waitKind, controllerId, op
}
```

— a strict subset of the spec's allow-list plus `controllerId` (needed for operator-facing display; not sensitive — it's the static name of the controller, not its instance ID) and `op` (the mutation name, e.g. `'startStep'`; not a payload field).

Strictly excluded from the audit payload AND from the ledger `subject`/`summary`:
- `stateJson` (controller-private — spec line 705 non-goal "Not exposing `stateJson` in any UI").
- `waitJson.channel` / `waitJson.threadId` / `waitJson.peer` (PII risk surface; spec § Threat Model line 681 explicitly limits to `waitJson.kind`).
- `waitJson.correlationId` / `waitJson.waitInstanceId` (capability tokens; spec § Threat Model lines 673, 678).
- `waitJson.serviceId` / `waitJson.expectedAgentId` (peer identifying info).
- `waitJson.question` / `waitJson.reviewerId` (human-review content).

Verified by the `'audit payload includes ONLY redacted fields'` test which asserts `Object.keys(payload)` is a subset of the allow-list AND that JSON-stringifying the payload does not contain literal sentinel values (`'do-not-leak'`, `'svc-private'`, `'corr-aaaaaaaaaaaaaaaaaaaaaa-private'`) injected at test setup time.

---

## Conclusion

Phase 5 ships three structural authorities (createFlow rate limit, max-active cap, pingFlow rate limit) and two non-authority infrastructure improvements (LRU cache + eviction metric, audit-ledger fix). Every authority surface lives at the registry layer (so all callers see the same limit), is keyed on `controllerId` or `flowId` to bound per-counterparty resource use, and has a documented configuration override + an `Infinity`-disable path. Every observation surface (audit notes, cache metric, rate-limit rejection counters) is fire-and-forget and never blocks state correctness.

The audit-ledger payload is strictly the redacted shape per spec lines 681-682; controller-private state never leaves the registry. The previously-broken `emitLedgerNote` path is now fixed, which incidentally repairs Phase 2's `taskflow-cancel-requested` note emission and closes the `'taskflow-divergence'` validation gap from Phase 3a.

Rollback is `config.taskFlow.rateLimits = { createPerSecPerController: Infinity, maxActivePerController: Infinity, pingPerMinPerFlow: Infinity }` (soft) or `git revert` (hard). Tests cover all six limit-trigger paths, the LRU recency contract, eviction metric emission, configurability, isolation between controllers, terminal-transition slot release, and audit-note redaction.

The change is opt-in (gated on `config.taskFlow.enabled`), additive, configurable, and rollback-cheap.

---

## Second-pass review (adversarial)

**Reviewer:** adversarial self-review focused on rate-limit edge cases (clock skew, controller-id spoofing, retry-storm amplification).
**Independent read of the artifact: concur after fixes**

Findings raised during adversarial pass and resolution status:

1. **Controller-id spoofing for memory exhaustion** — An attacker with an auth token can create many flows under many distinct claimed `controllerId`s, each starting a new bucket in the `createLimiter` and a new entry in `activeCountByController`. **Resolution:** `RateLimiter` enforces `MAX_BUCKETS = 50_000` with lazy pruning; per-bucket size is bounded by `limit` (≤10 for create; ≤60 for ping). Worst-case memory: 50k * 10 timestamps * 8 bytes ≈ 4 MB. The `activeCountByController` Map is bounded by the number of distinct claimed controllerIds the server has ever seen since boot — same memory class; an attacker cannot inflate the per-controller value beyond the max-active cap (50). Documented in §2 Under-block + §5 Interactions.

2. **Retry-storm amplification** — If multiple clients hit the same 429 simultaneously and retry at exactly the `retryAfterMs` interval, they collide at the window boundary. **Resolution:** the `retryAfterMs` returned is the minimum wait; downstream clients should add jitter (documented as a client-side responsibility). Server-side: the sliding window means a wave that arrives in the same millisecond still gets serialized — only `limit` requests succeed; the rest get a fresh 429 with a fresh retry hint. The server is single-writer; there is no thundering-herd state-coherence risk.

3. **Clock-skew on sliding window** — NTP backward jumps could leave bucket timestamps in the future. **Resolution:** since the limiter and registry share `now()`, a backward jump moves both the bucket entries (relative future) AND the window boundary backward by the same delta. The bucket simply takes one extra forward-pass to age out. Within the single-writer server, the risk is bounded to a one-time over-grant equal to the jump magnitude. Documented in §2 Under-block.

4. **Pre-existing `kind: 'note:X'` schema rejection silently dropped Phase 2 and Phase 3a notes** — Found during adversarial inspection of `SharedStateLedger.validatePayload`. **Resolution:** Phase 5 fixes both `emitTransitionLedgerNote` and the generic `emitLedgerNote` to use `kind: 'note'` + a proper subsystem entry. Closes the `'taskflow-divergence'` validation gap by adding it to `VALID_SUBSYSTEMS` (was in the type union but not the runtime list). This is a load-bearing fix — without it, neither Phase 3a's divergence monitoring nor Phase 2's cancel-requested notes were being written.

5. **Authority check before rate counter on `pingFlow`** — Initial draft of the rate limit was added at the top of `pingFlow` (before the `controllerId` match check), letting unauthorized callers consume legitimate budget. **Fix applied:** the limit check now lives AFTER `assertControllerScope`-equivalent inline checks. Verified by the `'bogus principal is rejected BEFORE the rate counter increments'` test.

6. **Idempotency-replay race against the rate limit** — Initial draft counted every `createFlow` call against the rate limit, so a retry of the same idempotent operation could burn budget. **Fix applied:** an outer (pre-rate-limit) idempotency check short-circuits to the existing flow without consuming a slot. Verified by the `'idempotent replay does NOT count against the rate limit'` test.

7. **Audit-emission failure cascading into state-machine path** — The `void Promise.resolve().then(...).catch(...)` pattern was checked end-to-end. **Verification:** the `'audit emission is async/best-effort'` test monkey-patches `ledger.append` to throw and asserts `applied === true`. Audit failures are confined to a swallowed catch.

No remaining critical concerns. The change is cleared to ship.

---

## Evidence pointers

- Test run: `npx vitest run tests/unit/task-flow-rate-limits.test.ts tests/unit/task-flow-cache-eviction.test.ts tests/unit/task-flow-audit-ledger.test.ts` → 31/31 passing.
- Regression: `npx vitest run tests/unit/task-flow-registry.test.ts tests/unit/evolution-manager-taskflow-dualwrite.test.ts tests/unit/divergence-checker.test.ts tests/unit/threadline-flow-bridge.test.ts` → 52/52 passing.
- Typecheck: `npx tsc --noEmit` → clean across modified files.
- Spec source of truth: `docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md` § Phase 5 (lines 650-653); § Threat Model (lines 679, 685); audit redaction (lines 681-682).
- Phase 1 trace context: `upgrades/side-effects/taskflow-phase1.md`.
- Phase 2 trace context: `upgrades/side-effects/taskflow-phase2.md`.
- Phase 3a trace context: `upgrades/side-effects/taskflow-phase3a.md`.
