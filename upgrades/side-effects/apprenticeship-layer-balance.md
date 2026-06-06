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
