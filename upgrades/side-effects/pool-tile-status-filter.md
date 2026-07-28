# Side-Effects Review — Pool dashboard tiles: filter remote sessions to live statuses

**Version / slug:** `pool-tile-status-filter`
**Date:** `2026-06-11`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `not required` (one-line client-side display filter; no lifecycle, no gates, no messaging surface)

## Summary of the change

The dashboard's pool poll fed `renderSessionList` every record a peer's plain `GET /sessions` returned — and that endpoint returns the peer's FULL registry, completed/killed records included — while local tiles are built from `listRunningSessions()` (running only). Result, observed live 2026-06-11 (topic 13481): five Mac Mini sessions closed hours earlier reappeared on the laptop dashboard as live "click to stream" tiles. One-line fix in `dashboard/index.html`: the remote merge now filters to `status === 'running' || status === 'starting'`, matching the local sidebar's definition of "live". New source-assert test (`tests/unit/dashboard-poolTileStatusFilter.test.ts`, following the established `dashboard-sessionMachineBadge.test.ts` at-rest inspection pattern) proven failing on the unfixed HTML first.

## Decision-point inventory

No decision points. A client-side display filter; the API response is unchanged and remains faithful (full registry, accurate statuses).

---

## 1. Over-block
A peer session in a transient status other than running/starting would be hidden — the only other statuses are terminal (`completed`/`failed`/`killed`), which is exactly what should be hidden. No issue identified.

## 2. Under-block
A peer whose registry wrongly marks a dead session `running` still renders a tile — that is the upstream ghost-record problem, fixed separately at the registry funnel (PR #1067); the two fixes are complementary layers, not overlap.

## 3. Level-of-abstraction fit
Correct layer: the SERVER's pool response stays a faithful full-registry view (other consumers may legitimately want terminal records, e.g. forensics); "which records are live tiles" is a display decision, made where display happens, identically to how local tiles already decide it.

## 4. Signal vs authority compliance
- [x] No — this change has no block/allow surface. (Display filtering only.)

## 5. Interactions
The remote-tile click path, machine badges, row namespacing, and stream subscriptions all operate on the filtered set — strictly fewer dead tiles to mis-click. The 15s pool poll cadence is unchanged. No shadowing/double-fire/races (pure pure-function filter on a fetch result).

## 6. External surfaces
`dashboard/index.html` ships in the npm package and replaces wholesale on update; no API change, no config, no migration. Mixed-version: an updated dashboard against any peer version works (the filter only reads fields every version already returns).

## 7. Rollback cost
Revert the one line, ship a patch. No state, no migration. Symptom during rollback window: dead peer tiles reappear (cosmetic).

---

## Conclusion

Minimal display-truthfulness fix; the registry-side ghost cleanup (PR #1067) and this filter together close both layers of the "dead sessions on the dashboard" symptom: records that should not say running, and tiles that should not render non-running records. Clear to ship.

**Phase 1 principle check (recorded):** no decision point — display filter.
**Phase 2 plan (recorded):** fresh worktree `.worktrees/fix-pool-tile-status-filter` off `JKHeadley/main` @ `e6c21fa8e` (v1.3.487), agent identity set, canonical remote verified. Rollback: revert (above).
