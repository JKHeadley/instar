# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### TaskFlow Phase 5 — hardening (rate limits + cache eviction + audit ledger)

The TaskFlow registry now enforces per-controller and per-flow rate limits, evicts its in-memory cache via a proper bounded LRU with an eviction metric, and writes a structured audit trail of every state-machine transition to SharedStateLedger. All limits are configurable; all defaults match the threat-model values in the TaskFlow spec.

**New 429 surfaces on the `/flows*` HTTP API:**

- `POST /flows` enforces (a) per-controller create rate (default 10/sec) and (b) per-controller max-active-non-terminal-flows cap (default 50). Overflow returns HTTP 429 with `error: 'quota_exceeded'`, a `code` field (`'rate_limit'` or `'max_active'`), the configured `limit`, and a `retryAfterMs` hint. The route also sets RFC 7231 `Retry-After` header (seconds, ceiled, min 1).
- `POST /flows/:flowId/ping` enforces a per-flow ping rate limit (default 60 pings/min/flow). Overflow returns HTTP 429 with `error: 'quota_exceeded'`, `code: 'rate_limited'`, `retryAfterMs`, and `Retry-After`. Unauthorized pings (wrong `controllerId`) are rejected with HTTP 422 BEFORE the rate counter increments — bogus pings cannot consume the legitimate controller's budget.

**Idempotent replays do NOT consume rate budget**: the route's existing idempotency-key short-circuit runs before the rate counter, so retrying the same `createFlow` payload is free.

**New configuration block** (under `config.taskFlow`):

```json
{
  "taskFlow": {
    "enabled": true,
    "rateLimits": {
      "createPerSecPerController": 10,
      "maxActivePerController": 50,
      "pingPerMinPerFlow": 60
    },
    "cache": {
      "maxEntries": 1000
    }
  }
}
```

Set any rate-limit field to `Infinity` to disable that gate. Set `cache.maxEntries: 0` to disable caching entirely.

**Cache improvements**: the registry's in-memory cache is now a proper LRU with recency-refresh on `get` and bounded capacity (default 1000). Each eviction emits `[metric] taskflow_cache_evictions_total=<n>` on the standard metric channel.

**Audit ledger trail**: every state-machine transition now writes a `note`-kind entry to `.instar/shared-state.jsonl` under subsystem `'taskflow-transition'`. The audit payload is the redacted shape per spec § Threat Model: `{ flowId, revision, currentStep, from_status, to_status, waitKind, controllerId, op }`. Controller-private fields (`stateJson`, all `waitJson` content beyond `kind`) are NEVER written to the ledger.

**Quiet bug fix**: Phase 2's `taskflow-cancel-requested` notes and Phase 3a's `taskflow-divergence` notes were previously silently dropped due to a schema-validation gap in `SharedStateLedger.VALID_SUBSYSTEMS`. This release closes the gap — both note kinds now land correctly.

### WikiClaim Phase 4 — inverse-traceability HTTP + dashboard

You can now ask the memory store two new questions over HTTP:

- **"What evidence backs this entity?"** — `GET /memory/evidence/by-entity/:id?viewerScope=...`
- **"Which entities cite this source?"** — `GET /memory/entities/by-evidence?kind=feedback&sourceId=fb_abc123&viewerScope=...`

Both routes are read-only, auth-required (bearer token), and viewer-scope filtered by `SemanticMemory` before any bytes leave storage. `viewerScope` is an optional query param defaulting to `private` (full visibility for the agent's own DB); pass a narrower scope to preview what a topic-peer or project-peer would see.

A new **Evidence** tab in the dashboard wraps both routes: enter an entity ID to see its evidence trail, or pick a kind + sourceId to find every entity citing that source. The "Inspect evidence" button on a citation result pivots you back to the per-entity view in one click.

## What to Tell Your User

- **Your TaskFlow API now has resource budgets**: "I added per-controller rate limits and a max-active-flows cap so a buggy or malicious controller can't flood the registry. Defaults: 10 new flows per second, 50 active flows, 60 heartbeats per minute per flow — all configurable. If a real workload hits a limit, just let me know and I'll raise it."
- **You can now read a full state-machine audit trail in shared-state.jsonl** — every TaskFlow state transition is logged under the taskflow-transition subsystem with redacted metadata (no controller-private state ever leaves the registry).
- **Divergence and cancellation notes that should have been landing since Phase 2/3a now actually land** — a schema-validation gap was silently dropping them. Operator dashboards now see those notes for the first time.
- **Memory evidence is now browsable**: "I added an Evidence tab in your dashboard and two HTTP routes that let me trace any claim back to its sources, or pivot from a source (a feedback report, a commit, a session) to every entity that cites it. Everything is viewer-scope filtered, so a narrower viewer never sees evidence above their tier."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Per-controller createFlow rate limit | automatic on `POST /flows`; `config.taskFlow.rateLimits.createPerSecPerController` |
| Per-controller max-active-flows cap | automatic on `POST /flows`; `config.taskFlow.rateLimits.maxActivePerController` |
| Per-flow ping rate limit | automatic on `POST /flows/:flowId/ping`; `config.taskFlow.rateLimits.pingPerMinPerFlow` |
| Configurable cache cap with LRU eviction | `config.taskFlow.cache.maxEntries` (default 1000) |
| Cache eviction metric | grep for `taskflow_cache_evictions_total=` in metric logs |
| State-transition audit trail | grep for `subsystem='taskflow-transition'` in `.instar/shared-state.jsonl` |
| Retry-After response header | clients that honor RFC 7231 § 7.1.3 see `Retry-After: <seconds>` on 429 |
| Per-entity evidence lookup over HTTP | `GET /memory/evidence/by-entity/:id?viewerScope=...` |
| Inverse-citation lookup over HTTP | `GET /memory/entities/by-evidence?kind=...&sourceId=...&viewerScope=...` |
| Dashboard Evidence tab | Open the dashboard → click "Evidence" |

## Evidence

Spec source of truth: `docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md` § Phase 5 (lines 650-653); § Threat Model (lines 679, 685, 681-682).

- `tests/unit/task-flow-rate-limits.test.ts` — 12 tests covering each limit's trigger, configurability, idempotent-replay carve-out, controller-isolation, and terminal-transition slot release.
- `tests/unit/task-flow-cache-eviction.test.ts` — 9 tests covering cap enforcement, LRU recency on `get`, metric emission, `setMaxEntries` resize, and `maxEntries=0` disable.
- `tests/unit/task-flow-audit-ledger.test.ts` — 10 tests covering each transition op's ledger emission, the redacted-payload contract (no `stateJson`, no `waitJson.payload` literal-sentinel asserts), dedupKey stability, and the audit-emission-doesn't-block-state-correctness contract.
- Regression: `tests/unit/task-flow-registry.test.ts`, `tests/unit/evolution-manager-taskflow-dualwrite.test.ts`, `tests/unit/divergence-checker.test.ts`, `tests/unit/threadline-flow-bridge.test.ts` — 52/52 passing.
- Side-effects review: `upgrades/side-effects/taskflow-phase5.md`.
