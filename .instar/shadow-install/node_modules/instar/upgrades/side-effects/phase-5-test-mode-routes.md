# Side-Effects Review — Phase 5 test-mode HTTP routes

**Cycle:** Phase 5 wiring step 1 — test-friendly endpoints + scenario validation
**Spec:** `specs/provider-portability/11-cost-aware-routing.md` (approved 2026-05-15)
**Reviewer status:** awaiting fresh second-pass.

## Summary of the change

Adds three HTTP endpoints to `src/server/routes.ts` that expose the
already-shipped Phase 5 components through a test-friendly surface:

- `GET /providers/routing/decide?...` — exercises
  `CostAwareRoutingPolicy.decide()` against synthetic adapters. Accepts
  `fakeRemainingUsd` / `fakeTotalUsd` / `fakeUnknown=1` to drive each row
  of the six-row decision matrix without needing real adapters or a real
  Anthropic UsageMeterProvider.
- `GET /providers/cost-state/diff?...` — exercises
  `CostStateTracker.isMaterialShift()` between two synthetic snapshots
  shaped from the query params. Returns the shift reason or null.
- `GET /providers/framework-router/route?taskPrompt=...&userId=...` —
  exercises `FrameworkModelRouter.route()` with stub IntelligenceProvider
  + in-memory PreferenceStore so the endpoint works on agents whose
  better-sqlite3 native module isn't built for the running Node version
  (e.g., deep-signal as of this session).

Each endpoint constructs ephemeral Phase 5 instances per call. None of
them mutate `Registry` or any persistent state; the in-memory
PreferenceStore is per-request.

The endpoints exist to be driven by the new test-driver-as-self pattern
(`~/.instar/agents/echo/.claude/scripts/run-v1-scenarios.{sh,py}` +
`.instar/scenarios/v1.0.0/`). They are the load-bearing piece for the
autonomous-mode stop-condition standard Justin set tonight (scenarios
must pass before autonomous can exit).

## Files touched (in /instar-dev scope)

- `src/server/routes.ts` — three new routes appended before the
  `return router` block. ~190 added lines, no existing lines modified
  beyond the anchor.

## Decision-point inventory

| Decision | Layer | Mode |
|---|---|---|
| Routing matrix row → adapter | Test-mode endpoint | signal-only (no production effect) |
| Material shift detection | Test-mode endpoint | signal-only |
| Framework + model pick | Test-mode endpoint | signal-only |

All three endpoints are read-only from the caller's view. They construct
ephemeral instances; no global state is mutated; no Telegram or external
side effects fire.

## 1. Over-block

The endpoints don't block anything. They run on the existing auth-gated
router and reject without bearer token, matching every other endpoint.

## 2. Under-block

Sensitive concerns to verify:

- **The `fakeRemainingUsd` / `fakeTotalUsd` / `fakeUnknown` query
  parameters bypass real UsageMeterProvider lookups.** This is
  intentional and the only path through the endpoint — there is no
  "production" mode where it queries the real meter. If callers want
  real-state routing decisions, they need a different endpoint that
  doesn't exist yet (tracked as Phase 5 follow-up).
- **The in-memory PreferenceStore stub for the framework-router endpoint
  means caller preferences don't persist across calls.** Acceptable for
  test-mode; real persistence requires the production PreferenceStore
  with a working better-sqlite3 build. Documented inline in the endpoint
  comments.
- **Endpoint is auth-gated** via the existing `authMiddleware`.

## 3. Level-of-abstraction fit

HTTP endpoints in `src/server/routes.ts` is the right layer:
- Same pattern as every other test-friendly endpoint in the file
  (e.g., `/internal/stop-gate/evaluate` is similarly synthetic-input).
- Co-located with the auth middleware, no special routing needed.
- The Phase 5 components are imported via dynamic `await import()` to
  keep the route module's static import surface unchanged — no risk of
  breaking other consumers of routes.ts via accidental side imports.

## 4. Signal vs authority compliance

- The endpoints are **signal-only**. Calling them does not register
  adapters, set the routing policy, or mutate any persistent state.
- The CostAwareRoutingPolicy, CostStateTracker, and FrameworkModelRouter
  classes themselves carry the authority — these endpoints just expose
  their decision functions to HTTP.
- No new structural enforcement; no decision gates are removed or
  weakened.

## 5. Interactions

- **Registry**: not touched. Adapters are not registered by these
  endpoints. `setRoutingPolicy` is not called.
- **Pre-existing routes**: not modified. The anchor (`return router`)
  is unchanged in semantics; the new routes are appended before it.
- **Test suite**: the existing unit tests for CostAwareRoutingPolicy /
  CostStateTracker (23 tests) and the existing FrameworkModelRouter
  tests continue to cover the underlying logic. The new endpoints don't
  introduce coverage gaps in those classes.
- **The PreferenceStore stub does NOT touch the real database** that
  the `instar route` CLI uses. The CLI's behavior is unaffected.
- **better-sqlite3 dependency** in the real PreferenceStore is sidestepped
  via the in-memory stub. Agents with broken native modules can still
  use the test-mode endpoint. Production routing via the `instar route`
  CLI is unchanged — it still requires the working native build.

## 6. External surfaces

- Adds three new URL paths to the public HTTP surface. Documented in
  `instar-dev` skill convention; no breaking changes to existing paths.
- Auth-gated; no unauthenticated information disclosure.

## 7. Rollback cost

Revert one commit. The endpoints disappear; all existing functionality
continues unchanged. The test driver in echo's home becomes a no-op
against any agent without the deployed routes — gracefully reports
"FAIL ... status 404" rather than corrupting anything.

Total rollback: under 5 minutes. No data loss.

## Conclusion

This is a test-surface addition that exposes already-existing Phase 5
logic through HTTP for the test-driver-as-self standard. No production
behavior changes; no security surface widens beyond the existing
auth-gated read endpoints.

## Test evidence

The driver at `~/.instar/agents/echo/.claude/scripts/run-v1-scenarios.{sh,py}`
runs the catalog at `~/.instar/agents/echo/.instar/scenarios/v1.0.0/`
against deep-signal. Results after deploying this commit's changes:

```
PASS 00-smoke-ping
PASS 01-health-baseline
PASS 02-capabilities-routing
PASS 03-spec12-env-scrub-deployed
PASS 04-route-decision-baseline
PASS 05-route-decision-low-credit
PASS 06-route-decision-unknown-credit
PASS 07-route-decision-healthy-credit
PASS 08-route-decision-non-anthropic-defers
PASS 09-cost-state-shift-detection
PASS 10-framework-router-anthropic-default

── Summary ──
  total:    11
  pass:     11
  fail:     0
```

All scenarios validate the endpoints end-to-end on a live agent —
deep-signal in this case. Echo drove the test loop entirely (sent
synthetic Telegram messages, polled deep-signal's responses, ran HTTP
assertions on the new endpoints).

## Second-pass review

Independent reviewer (fresh subagent, no shared context) read the
artifact, the implementation in `src/server/routes.ts`, the scenario
catalog, and the spec. Verdict: **CONCUR**.

Endpoints individually verified:
- `/providers/routing/decide` — CORRECT. Constructs ephemeral
  CostAwareRoutingPolicy per call, no global state mutation, auth-gated,
  exercises every row of the spec's six-row decision matrix.
- `/providers/cost-state/diff` — CORRECT. Pure-function call into
  `isMaterialShift`, two synthetic snapshots, no `snapshot()` invocation.
- `/providers/framework-router/route` — CORRECT WITH CAVEAT (resolved).
  The stub PreferenceStore satisfies the get/set/clear surface
  FrameworkModelRouter consumes (verified against source). Real
  PreferenceStore SQLite path is never opened, so `instar route` CLI is
  unaffected.

Reviewer issues (all addressed below or filed as non-blocking
follow-ups):

1. **LOW (FIXED) — Unvalidated numeric coercion**. NaN from `Number("abc")`
   would silently propagate to deferred-routing branches. Fixed in same
   commit: both endpoints now reject with 400 on non-finite values.
2. **INFO — PreferenceStore is a class, not an interface**. Future
   additions to the router's store surface would break the stub silently.
   Filed as follow-up: extract `PreferenceStoreLike` interface; not
   blocking — current router only calls get/set/clear.
3. **INFO — Dynamic await import() is correctly scoped**. Per-handler
   imports don't pollute routes.ts static graph; Node's ESM cache means
   no per-request state leakage.

Production-path impact: ZERO. Registry untouched, no `setRoutingPolicy`,
no PreferenceStore DB writes, no adapter registration. `instar route`
CLI fully isolated from the test-mode endpoints.

**Verdict: CONCUR.**
