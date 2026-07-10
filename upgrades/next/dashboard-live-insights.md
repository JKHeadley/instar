# Upgrade Guide — Dashboard Live-LLM-Insights

<!-- bump: minor -->

## What Changed

The dashboard gained a new **Insights** tab (first in the Runtime group) — the "at-a-glance meaning" layer on top of the raw data the other 25 tabs show. For each page it renders one calm **Insight Strip**: a single plain-English (ELI16) headline naming the most important thing about that page's data, up to three short supporting lines, and a button to open the page the insight came from. It turns "here are 40 numbers" into "here's the one thing worth a look, and where to look" (operator directive, topic 29723: *"extremely digestible • clearly actionable • simple (think eli16) but clear paths to drill into details • use of LLM intelligence to provide active/live insights into page data"*).

Two layers produce each strip. A **deterministic one-liner** computed straight from the page's numbers is always available — so the tab is useful and honest even with the AI turned off. When the feature is live, an **LLM insight** is generated instead, routed through the agent's existing nature-router down its **FAST lane**: the model is chosen by the benchmark-derived routing chains (never hardcoded), the call is metered under component `DashboardInsightEngine` in the LLM Activity tab, it is generated only on view and **cached per page for 5 minutes** (unchanged data never re-spends), and it degrades back to the deterministic one-liner on any failure or timeout. The insight is strictly **awareness-only**: it observes and phrases, it never acts, never mutates state, and never links to a mutating action.

New read-only routes back the tab: `GET /insights`, `GET /insights/:page`, `GET /insights/status`. The feature ships **dark on the fleet and live on a development agent** (the standard maturation ladder), and even on a dev agent the actual LLM spend stays behind a `dryRun` switch (the deterministic floor renders; the LLM only logs "would generate") until an operator deliberately flips `dryRun:false` after a soak. This ship wires the **LLM Activity** page collector end-to-end (the motivating example — it separates real routing errors from mesh-probe noise); additional page collectors and the cross-page "what needs you" digest are tracked follow-ups (the engine, route, and UI are page-generic).

## What to Tell Your User

- "There's a new **Insights** tab in your dashboard. It reads each page's data and tells you, in one plain sentence, what stands out — plus a button to open the page it came from. It only explains; it never changes anything."
- "The insights can be written by an AI model, chosen automatically by our benchmark-tuned routing (the cheap, fast lane) and cached for 5 minutes so it doesn't waste money. If the AI is unavailable, you still get a plain summary computed from the numbers — the tab never breaks."
- "It's on for development agents and off for everyone else for now; even on a dev agent the AI spend is held behind one more switch until it's been watched working. No action needed — open the Insights tab (first tab in the dashboard)."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Per-page Insight Strip (Insights tab) | Open the **Insights** tab in the dashboard (dashboard URL + PIN) |
| Cross-page insight digest (API) | `GET /insights` — every page's strip; `GET /insights/:page` — one page |
| Insight posture (API) | `GET /insights/status` — enabled / dryRun / ttl / pageCount |
| AI insight routing | Automatic — the FAST lane of the nature-router (model from the benchmark chains); metered under `DashboardInsightEngine` in LLM Activity |
| Enable real AI insights (dev agent) | Set `dashboard.liveInsights.dryRun: false` after a soak (default `true`) |
| Fleet enable | Set `dashboard.liveInsights.enabled: true` (dev-gated dark by default) |

## Evidence

- **Unit** (`tests/unit/dashboard-insight-engine.test.ts`, 21 tests): the deterministic floor (anomaly headline / affirmative-healthy / empty / paused / throwing-collector), the LLM path + exact FAST-lane attribution (`model:'fast'`, `component:'DashboardInsightEngine'`, `nature:'A'`, `gating:false`, `injectionExposed:true`), snapshot-fingerprint caching (unchanged → no re-spend; changed / TTL-expired → regen), degrade-to-floor on throw + on unparseable output, the `dryRun` spend canary (LLM never called), untrusted enveloping, and the parser's severity clamp.
- **Integration** (`tests/integration/insights-routes.test.ts`, 5 tests): the dark→live gate — 503 on every route when the engine is null, 200 with the strip payload when wired, 404 on an unknown page, and the LLM source rendered under `dryRun:false`.
- **E2E "feature is alive"** (`tests/e2e/insights-alive.test.ts`, 3 tests): the developmentAgent gate resolves LIVE on a dev agent / DARK on the fleet over the REAL ConfigDefaults; `GET /insights` returns a real insight payload built by the REAL LLM-Activity collector over a REAL `FeatureMetricsLedger` (a genuinely failing check surfaces); the dark contract 503s.
- **Ratchets** re-green after the map additions: `llm-bench-coverage-ratchet`, `llm-routing-nature-ratchet`, `nature-routing-injection-exposure-ratchet`, `untrusted-input-classification-ratchet`, `llm-attribution-ratchet` (componentCategories wiring), `devGatedFeatures-wiring`, `capabilities-discoverability`, `lint-dev-agent-dark-gate`, and the three dashboard UX floors (F1/F2/F3). Typecheck clean.
