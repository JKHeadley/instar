# Side effects — classify the session-pool route prefixes (capability-discoverability lint)

## What this fixes
The CI `capabilities-discoverability` lint requires every route prefix in routes.ts to be classified in `src/server/CapabilityIndex.ts` — either discoverable (CAPABILITY_INDEX) or explicitly internal (INTERNAL_PREFIXES). The session-pool added three unclassified prefixes (`/pool`, `/mesh`, `/session-pool`), failing shard 1/4 on #506. Classified now:
- **`/pool` → discoverable** (new CAPABILITY_INDEX entry `multiMachinePool`): it's the agent-facing "where is this running? / move this to <nickname>" + Machines-tab status surface. build reports `configured: !!machinePoolRegistry` + endpoints.
- **`/mesh` → INTERNAL**: machine-to-machine MeshRpc transport (Ed25519-signed peer traffic), never an agent/user capability.
- **`/session-pool` → INTERNAL**: rollout-gate E2E results — operator observability for a dark feature.

## Risk / blast radius
None — classification metadata only; no runtime behavior change. `/pool` now appears in /capabilities (correct — it's the documented multi-machine status surface).

## Tests
- `tests/unit/capabilities-discoverability.test.ts` — 98 pass (was 3 failing on /mesh, /pool, /session-pool). This is the lint that gates route-prefix classification fleet-wide.

## Lesson
Ran only the pool test files locally, not the cross-cutting lint — the capabilities-discoverability lint runs against ALL routes, so new routes need classification. CI caught it; running the full unit suite (or this lint) locally before push would have caught it sooner.
