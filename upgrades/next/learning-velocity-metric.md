<!-- bump: minor -->

## What Changed

Adds a **learning-velocity metric** — Salim Ismail's EXO 3.0 KPI inversion (from
*Your KPI System Is Training You to Miss the Future*). Backward-looking
operational KPIs (throughput, utilization, efficiency) reward the existing model
and suppress the weak signals where the future shows up. The EXO 3.0 answer is to
measure how fast you're **learning** — adaptability, experimentation, capability
creation.

Instar already emits the raw learning events (registered learnings, captured
corrections, evolution actions); this turns them into a signal:

- `GET /metrics/learning-velocity?windowDays=30` → `{ totalEvents, eventsPerDay,
  byType, typeDiversity, trend, adaptabilityScore, reason }`.
- `trend` is `accelerating` | `steady` | `declining` | `insufficient-data`
  (first-half vs second-half of the window).
- `adaptabilityScore` (0–100) blends velocity (saturating) with category
  diversity.

Read-only + advisory — it never gates anything. A flat or declining trend is the
EXO 3.0 warning sign that the org is optimizing the old model instead of learning.

## Evidence

Three-tier coverage, all green, `tsc --noEmit` clean:

- Unit — `LearningVelocityScorer.test.ts` (6): empty, window exclusion,
  accelerating, declining, insufficient-data, and byType/diversity/adaptability.
- Integration — `learning-velocity-routes.test.ts` (3): the route reads a real
  `learning-registry.json` + corrections over HTTP and computes.
- E2E — `learning-velocity-lifecycle.test.ts` (1): a real server on a real port,
  feature alive end-to-end (200, not 404/503).

CLAUDE.md scaffold template documents the endpoint.
