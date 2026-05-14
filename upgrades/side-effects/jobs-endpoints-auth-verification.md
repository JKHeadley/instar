# Side-effects review — Jobs endpoints auth verification

## What changed

Single new integration test `tests/integration/jobs-endpoints-auth.test.ts` asserts the four Phase 4 jobs endpoints are gated by the existing global `authMiddleware` per INSTAR-JOBS-AS-AGENTMD spec §Decision Points "Dashboard write authorization — bearer auth extended to job-edit endpoints."

15 cases cover unauthenticated, wrong-token, off-by-one-token, malformed-header, non-Bearer-scheme, and authenticated paths × 4 endpoints (`/jobs/migration-status`, `/jobs/migration-confirm`, `/jobs/migration-abandon`, `/jobs/reconcile`).

No new code paths. The endpoints inherit bearer-token gating from the global `authMiddleware` (already wired in `src/server/middleware.ts`). This PR is the test that asserts the property the spec requires.

## Side-effects review

### 1. Over-block / under-block

- **Over-block:** none. The test asserts what the middleware already does. Pass rate today: 100%.
- **Under-block:** the four migration endpoints write a sentinel marker (`.migration-complete.json`) or trigger `jobsMigrate({ abandon: true })`. They are NOT tool-allowlist-widening endpoints. The spec's ops-gate routing requirement for "Allowlist widening" applies to future tool-allowlist-mutation endpoints that don't exist yet. When those land (Dashboard UI rewrite), they will route through the existing `operations/evaluate` gate per §Decision Points.

### 2. Level-of-abstraction fit

Pure integration test against the shipped `authMiddleware`. Spins up a minimal Express app with mock handlers (the real handler logic is exercised in other tests).

### 3. Signal-vs-authority compliance

The test is the signal that the auth-gate property is intact. The `authMiddleware` itself is the authority. If a future refactor weakens the gate, this test fails.

### 4. Interactions

- **Phase 4 endpoints (PR #195)** — auth was already in place via global middleware; this test pins it.
- **Phase 4 reconcile endpoint (PR #212)** — same.
- **Future Dashboard UI rewrite** — will add tool-allowlist-mutation endpoints (e.g., `POST /jobs/:slug/allowlist`); those endpoints will need ops-gate routing for widening per spec. Out of scope here.

### 5. Rollback cost

Trivial. Single test file.

## Test coverage

15 cases pass:

- 4 endpoints × unauthenticated → 401
- 4 endpoints × wrong-token → 401-or-403 (middleware returns 403 for failed validation; both are "denied")
- 4 endpoints × correct-token → 200
- Off-by-one near-miss token → rejected
- Empty `Bearer` header → 401
- Non-Bearer scheme (`Basic <token>`) → rejected

Lint + type-check pass.

## What is NOT in this PR

- Ops-gate routing for tool-allowlist widening — depends on future Dashboard UI endpoints. Will be added when those endpoints ship.
- Per-endpoint role-based authorization (Dashboard-only operator vs CLI vs Telegram) — out of scope; the bearer token is the single trust boundary.
