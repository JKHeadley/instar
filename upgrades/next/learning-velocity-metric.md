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

## What to Tell Your User

Your agent can now answer "are we actually learning, or just running?" with real numbers. Ask it for its learning velocity and you get a trend — accelerating, steady, or declining — built from its genuine learning events (lessons it recorded, corrections it absorbed, capabilities it grew) instead of backward-looking activity stats. The EXO 3.0 idea behind it: traditional KPIs measure how well the OLD model runs; learning velocity measures whether you're building the next one. A flat or declining trend is your early warning that things are coasting.

## Summary of New Capabilities

- `GET /metrics/learning-velocity?windowDays=30` — `{ totalEvents, eventsPerDay, byType, typeDiversity, trend, adaptabilityScore (0-100), reason }`, computed from registered learnings, corrections, and evolution actions. Read-only + advisory — never gates.
- PROACTIVE trigger: "are we learning/adapting?" → read this metric and contrast it with operational throughput.

## Evidence

Three-tier coverage, all green, `tsc --noEmit` clean:

- Unit — `LearningVelocityScorer.test.ts` (6): empty, window exclusion,
  accelerating, declining, insufficient-data, and byType/diversity/adaptability.
- Integration — `learning-velocity-routes.test.ts` (3): the route reads a real
  `learning-registry.json` + corrections over HTTP and computes.
- E2E — `learning-velocity-lifecycle.test.ts` (1): a real server on a real port,
  feature alive end-to-end (200, not 404/503).

CLAUDE.md scaffold template documents the endpoint.
