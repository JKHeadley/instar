# Upgrade Guide — Pool dashboard tiles: live remote sessions only

<!-- bump: patch -->

## What Changed

The dashboard's pool poll rendered EVERY record a peer's `GET /sessions` returned — including completed/killed registry records — as live "click to stream" tiles, while local tiles come from `listRunningSessions()` (2026-06-11: five closed Mac Mini sessions reappeared on the laptop dashboard hours after closure). The remote merge in `dashboard/index.html` now filters to `running`/`starting`, matching the local sidebar's definition of live. API unchanged (the pool response remains a faithful full-registry view). Complements the registry-side ghost-record supersession fix — together: records stop claiming to be running, and the dashboard only draws records that claim to be running.

## What to Tell Your User

- "The dashboard now only shows sessions that are actually running on each machine — closed sessions on another machine no longer reappear as clickable tiles."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Truthful remote session tiles | Automatic |

## Evidence

- New source-assert test `tests/unit/dashboard-poolTileStatusFilter.test.ts` (established at-rest inspection pattern), proven failing on the unfixed HTML first (2/2 fail → 2/2 pass).
- Side-effects artifact: `upgrades/side-effects/pool-tile-status-filter.md`.
