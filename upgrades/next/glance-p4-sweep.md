# Dashboard glance Phase 4 — the sweep + cache-skew fix (#1441) + tab-survives-refresh (#1442)

<!-- bump: minor -->

## What Changed

Phase 4 of the operator-approved four-phase glance rollout (topic 29836). Every remaining
**data-summary** dashboard tab is rebuilt on the shared glance component (F10/F11), and two
filed issues are fixed dashboard-wide:

- **Six tabs rebuilt as glances.** PR Pipeline, Tokens, LLM Activity, Secrets, Resource
  Usage, and Initiatives now each lead with a plain-English headline over ≤5 big labeled
  tiles; tap a tile to see the rows behind that number in plain words, tap a row for the
  full record where the IDs, commit shas, session ids, cadences, and per-model detail live.
  Nothing was removed — the raw detail just moved one or two taps down. Where a tab had
  actions, they were **preserved** (a Secret's open / copy / cancel buttons now sit on its
  record). All six left the "grandfathered" list, so the ratchet ceiling dropped 20 → 14 and
  they are now held to the same glance floor as every new view.
- **#1441 — a deploy can no longer break warm-cache browsers.** Dashboard static assets
  (index.html, glance.js, and everything it imports) are now served `Cache-Control: no-cache`
  with an ETag, so the browser revalidates each load instead of pairing a fresh page with a
  stale, months-old script. This ends the class of bug where, after a deploy, a whole tab
  went blank for up to 4 hours until a hard refresh.
- **#1442 — the dashboard stays on the same tab across a refresh.** The URL now records the
  selected tab (`?tab=<id>`) for every tab, not just Files, and a refresh restores it. An
  unknown or removed tab id falls back to the default with no error; existing
  `?tab=files&path=…` deep links keep working byte-for-byte.

The other 14 tabs are interactive consoles, forms, browsers, or bespoke-polling modules
(Jobs, Features, Projects, Mandates, Subscriptions, Files, Send Content, Evidence,
Threadline, Sessions, Process Health, Preferences, plus the Insights reference pattern).
A read-only glance would strip their inline actions and change what the tab *does* — a
non-goal of the standard — so they stay grandfathered as operator-ratified exceptions.

## What to Tell Your User

Six more of your dashboard tabs are now readable at a glance. **PR Pipeline**, **Tokens**,
**LLM Activity**, **Secrets**, **Resource Usage**, and **Initiatives** each open with one
plain sentence and a few big tiles instead of a wall of tables and jargon — tap a tile to see
which items are behind that number, and tap one for its full details. Two annoyances are also
gone: after a new version ships, the dashboard no longer shows a blank tab until you hard-
refresh (it now always loads the matching code), and refreshing the page keeps you on the
tab you were looking at instead of bouncing you back to Sessions. Your Secrets links still
open, copy, and cancel exactly as before — those buttons just moved onto each request's
detail view. Nothing was removed anywhere; details just live a tap or two down.

## Summary of New Capabilities

- The **PR Pipeline**, **Tokens**, **LLM Activity**, **Secrets**, **Resource Usage**, and
  **Initiatives** dashboard tabs are rebuilt as glances (headline + ≤5 tiles → filtered rows
  → full record), replacing their raw tables/metric grids.
- Dashboard static assets are served `Cache-Control: no-cache` + ETag, so a deploy can never
  leave a warm-cache browser on stale code (#1441).
- The selected dashboard tab is recorded in the URL and survives a page refresh; unknown tab
  ids degrade safely (#1442).
- The F10/F11 glance floors now gate 12 tabs; the grandfather ceiling ratcheted 20 → 14.

## Evidence

- Unit: `tests/unit/dashboard-glance-word-budget.test.ts` (102) and
  `tests/unit/dashboard-glance-drilldown.test.ts` (32) — the six new builders under
  adversarial fixtures (empty / null / large-N / jargon-laden) all produce conforming
  glances, every tile walks tile→list→record, an XSS payload renders inert, and the
  grandfather ratchet (completeness + monotonicity, ceiling 14) is asserted structurally.
- Unit: `tests/unit/dashboard-cache-headers.test.ts` (5, #1441) and
  `tests/unit/dashboard-tab-url-state.test.ts` (15, #1442, the shipped inline functions
  run in jsdom with a write→refresh→restore round-trip).
- Integration: `tests/integration/glance-sweep-tabs.test.ts` (11, each builder over the real
  route response / documented dark 503) and `tests/integration/dashboard-static-cache.test.ts`
  (4, real Express serving the real dashboard dir: no-cache + ETag + a 304 on If-None-Match).
- E2E: `tests/e2e/glance-sweep-lifecycle.test.ts` (7, feature-alive: routes reachable, the
  shipped glance renders end-to-end, no XSS survives, glance.js exports every builder).
- Spec: `docs/specs/dashboard-ux-standard.md` (F10/F11 conformance table updated — six tabs
  on the floor, the 14 exceptions enumerated with their reasons).
