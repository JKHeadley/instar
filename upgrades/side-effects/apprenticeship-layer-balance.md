# Side-Effects Review - apprenticeship layer-balance signal

**Version / slug:** `apprenticeship-layer-balance`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

Adds an observe-only `keystoneBalance` block to `ApprenticeshipCycleStore.roleCoverage()` (surfaced via `GET /apprenticeship/instances/:id/role-coverage`). It makes the deepest-layer (mentor→mentee keystone) health a queryable fact: starved when the keystone never fired while oversight did, or enough oversight accrued since the last drive (default 3, tunable via `?oversightStarvationThreshold`). Generalizes the existing narrow `driftWarning`.

## Decision-point inventory

- `computeKeystoneBalance` (new, private) - pure function over the already-tallied axes + oversight timestamps; no I/O.
- `roleCoverage(instanceId, opts?)` - modify - gains an optional opts param (back-compat: existing single-arg callers unchanged) and returns the new `keystoneBalance` field.
- role-coverage route - modify - parses optional `?oversightStarvationThreshold` and passes it through.

## 1. Behavior change / gating

NONE. This is observe-only. It adds a computed read-only field; it never blocks a cycle record, never gates a transition, never alters the loop. The existing `driftWarning` is untouched (kept for back-compat). No new failure modes.

## 2. Over/under-signal

- Over-signal (false "starved"): a long-idle instance whose keystone fired once then sat through 3+ reviews reads starved even if that's intended. Acceptable — it's a surfaced signal a human/loop reads, not an action; and "intended long review phase" is exactly the thing worth surfacing.
- Under-signal: an instance with keystone fired recently + <threshold oversight reads healthy even if the mentee is actually stuck. Acceptable for this slice — the signal is about cadence/balance, not per-drive quality (that's operatorSeatUx + the transcript auditor's job).

## 3. Blast radius

`roleCoverage()` callers: the one route + tests. The added param is optional, so every existing call compiles and behaves identically (just gains the extra field). No persistent-state change (computed from existing rows), so NO migration and NO data backfill. The field appears automatically for all instances, including legacy/grandfathered ones (their keystone history is read as-is).

## 4. Failure modes

`computeKeystoneBalance` is pure and total — no throw paths, no I/O. A malformed threshold from the query string falls back to the default (parsed-int guard). ISO string timestamp comparison is safe (createdAt is always normalized ISO).

## 5. Migration parity

No agent-installed files change. The signal is a new read-only API field, so Agent Awareness gets a one-line mention in the CLAUDE.md template + a PostUpdateMigrator backfill so deployed agents learn the state question ("is my mentee layer starving?"). No config, hooks, or skills touched.

## 6. Scope honesty (what this is NOT)

Observe-only by design. It does NOT auto-correct the imbalance — the natural phase-2 (a cadence rule that makes the autonomous loop drive the mentee layer at least once per K mentor cycles) is deliberately deferred so the signal proves out first (Graduated-Feature-Rollout discipline; ship the observation structure before the enforcement law — the same order as #856/#864 before the #861 constitution article).

## 7. Incidental fix carried by this PR (`src/server/routes.ts`)

Merging current `main` surfaced a pre-existing route-completeness ratchet break introduced by #884 (P1 Coherence Journal): the new `/coherence/journal` route caught `InvalidCursorError` then `throw err` for everything else. That left routes.ts at 225 `catch (err)` / 224 `err instanceof Error` (ratchet red) and leaked an unhandled Express HTML 500 on any non-cursor error.

- **Decision point:** the journal route's catch block — `modify`. Behavior change: a non-cursor error now returns a clean JSON `{ error }` 500 instead of propagating to Express's default HTML error handler. Strictly better (no stack-trace leak), no new failure mode.
- **Causal autopsy:** balance was even (224/224) at `6c2af5a6a`, went to 225/224 at `7afa768f5` (#884). Confirmed via per-commit catch/instanceof bisect.
- **Blast radius:** one route's error path. No state, no migration, no gating. Rebalances the ratchet to 225/225 (route-completeness green).
- **Why carried here vs separate PR:** the merge made this PR's CI red and #893 can't go green without it; owned per the Zero-Failure Standard ("there is no such thing as a pre-existing failure"). Documented loudly rather than silently bundled.
