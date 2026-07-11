# Side-Effects Review — Dashboard glance Phase 4 (the sweep) + #1441 + #1442

**Version / slug:** `glance-p4-sweep`
**Date:** `2026-07-11`
**Author:** Echo (autonomous, topic 29836)
**Second-pass reviewer:** not-required (Tier 2; dashboard-render + a serving-header change, no fleet-state or destructive path)

## Summary of the change

Phase 4 of the operator-approved glance rollout. Six remaining **data-summary** dashboard
tabs (PR Pipeline, Tokens, LLM Activity, Secrets, Resource Usage, Initiatives) are rebuilt on
the shared `dashboard/glance.js` component (F10/F11 floors), leaving the grandfather list
(ceiling 20 → 14). Two filed issues ride along: **#1441** (dashboard statics served
`Cache-Control: no-cache` + ETag so a deploy can't pair a fresh index.html with a stale
glance.js) and **#1442** (the selected tab survives a page refresh via `?tab=<id>`).

Files added:
- `dashboard/glance.js` — six new pure builders + specs (`buildPrPipelineGlance` /
  `prPipelineGlanceSpec`, `buildTokensGlance` / `tokensGlanceSpec`, `buildLlmActivityGlance` /
  `llmActivityGlanceSpec`, `buildSecretsGlance` / `secretsGlanceSpec`, `buildResourcesGlance` /
  `resourcesGlanceSpec`, `buildInitiativesGlance` / `initiativesGlanceSpec`) + shared
  `fmtPct` / `fmtBytes` helpers. Registries: the six tabs moved to `GLANCE_ADOPTED_TABS`;
  ceiling lowered 20 → 14.
- Tests: `tests/unit/dashboard-cache-headers.test.ts`, `tests/unit/dashboard-tab-url-state.test.ts`,
  `tests/integration/dashboard-static-cache.test.ts`, `tests/integration/glance-sweep-tabs.test.ts`,
  `tests/e2e/glance-sweep-lifecycle.test.ts`; Phase-4 blocks appended to the two glance unit tests.
- `upgrades/next/glance-p4-sweep.md` — release fragment.

Files modified:
- `src/server/middleware.ts` — added `dashboardCacheControl(res)` (sets `Cache-Control: no-cache`)
  and the exported `DASHBOARD_STATIC_OPTIONS` object used by both the wiring and its test (#1441).
- `src/server/AgentServer.ts` — static serving now uses `DASHBOARD_STATIC_OPTIONS` + a no-cache
  `res.sendFile` for the index route (#1441).
- `dashboard/index.html` — six loaders rewired onto `renderGlance` (their old per-tab table/grid
  markup replaced by a `.glance-root`); `updateFileUrl` → `updateUrlState` (records the tab for
  every tab) + `handleDeepLink` validates any `TAB_REGISTRY` id (#1442); a small
  `.glance-record-actions` CSS rule; the secrets countdown ticker retired.
- `docs/specs/dashboard-ux-standard.md` — Phase-4 marked shipped; conformance table + the 14
  exceptions enumerated.

## Decision-point inventory

- **Added (#1441 cache directive):** `no-cache` (revalidate-always), NOT `no-store`.
  Rationale: keeps the ETag/Last-Modified 304 path efficient (unchanged assets 304 instead of
  re-downloading) while still forbidding a stale copy from being used without revalidation, and
  Cloudflare honors `no-cache` by not edge-caching — killing both halves of the deploy skew.
  Reversible: a one-line header change. Blast radius: dashboard responses only (path-scoped);
  no other route's caching is touched.
- **Added (#1442 URL writer):** the default Sessions tab omits `?tab=` to keep bare URLs clean
  and preserve the legacy "no query → Sessions" boot. Unknown/removed `?tab=` values validate
  against `TAB_REGISTRY` and fall back to the default with no `switchTab` and no console error.
  Existing `?tab=files&path=…` deep links are preserved (asserted in a round-trip test).
- **Preserved behavior (non-goal guard):** the only converted tab with mutating actions is
  Secrets; its open / copy / **cancel** (`DELETE /secrets/pending/:token`) actions were moved
  intact onto the Layer-3 record (`onCancel` opt), asserted by a drilldown test. No tab lost a
  capability. The 14 console/form/module tabs were deliberately NOT converted precisely because
  a read-only glance would strip their inline actions — enumerated as ratified exceptions.
- **No new machine-divergent state:** `glance.js` remains a stateless client renderer (posture
  `unified`); the builders read only the responses their tabs already fetch. No config, no
  persistence, no new endpoint. The `#1441` header change is a pure serving directive.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The six converted tabs ARE operator surfaces, and the F10/F11 glance floors are the
structural enforcement of this exact standard. Per criterion:

1. **Leads with the primary action?** Yes. These six are read-only *views* — the thing
   the operator came for is the state itself, and each glance leads with a one-sentence
   plain-English headline + ≤5 big tiles (the answer is the first and largest thing on
   screen), never explanatory prose or a collapsed toggle. Secrets is the only tab with
   mutating actions; its primary content (which requests are waiting) still leads, and
   the actions sit on the record one tap down.
2. **Zero raw internals as primary content?** Yes — this is precisely the F10 jargon
   floor, enforced by `validateGlanceSpec` + `tests/unit/dashboard-glance-word-budget.test.ts`:
   no IDs, shas, cadences, config keys, or enum/slug values may appear at Layer 1. The
   raw internals (commit shas, session ids, latencies, tokens, config) live at Layer 3,
   reached by drilling, shown as muted support fields.
3. **Destructive actions de-emphasized?** Yes. The only destructive action across the six
   is a Secret request's **Cancel**, which lives on the Layer-3 record (two taps below the
   glance), grouped after the constructive Open / Copy actions, never above the glance.
4. **Plain language + phone width?** Yes. Plain language is the F10 floor (verified by the
   jargon scan over every headline + tile). The `.glance-root` is a flex column and the
   tiles wrap (`.glance-tiles` is a responsive grid), inheriting the F4 "body never scrolls
   sideways" floor; records use `word-break`/`overflow-wrap` so nothing truncates. Verified
   rendering the six real builders end-to-end in a real Chromium (Playwright): plain
   headlines, wrapping tiles, tile→list→record drill all working.

## 7. Multi-machine posture (Cross-Machine Coherence)

**unified — by construction.** `dashboard/glance.js` is a stateless client-side renderer:
it persists nothing, reads no config, holds no server state, and renders only the
responses each tab already fetches (inheriting those endpoints' existing posture). It
introduces no new machine-divergent state. #1441 is a pure serving directive (a response
header). #1442 is per-browser URL state (History API), not machine-divergent. No
user-facing notices are emitted (no one-voice gating needed), no durable state is held
(nothing strands on topic transfer), and the only generated URL (a Secret's drop link)
comes from the server's existing `secretDropUrl`, unchanged — so nothing needs a
`machine-local-justification` marker.

## Risk assessment

- **Runtime blast radius:** client-side render + one serving header. No scheduler, session,
  git, or fs path touched. A builder that throws is caught by `renderGlance`'s per-drill
  try/catch (honest degraded state, never a white-screen), and each loader degrades to a
  friendly `.glance-empty` note on a 503/404/error.
- **Migration parity:** met by construction — the dashboard ships wholesale via
  `express.static` from the package dir, so deployed agents receive the new `glance.js` +
  `index.html` on the normal update path (same as Phases 1–3). No `PostUpdateMigrator` entry
  needed. The `#1441` header lives in shipped server code (`middleware.ts`), delivered on the
  same update.
- **Reversibility:** every change is reversible (revert the header, revert the loaders). No
  irreversible or financial operation.
