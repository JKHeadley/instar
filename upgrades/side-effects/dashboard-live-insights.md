# Side-Effects Review — Dashboard Live-LLM-Insights

Spec: `docs/specs/dashboard-live-insights.md` (operator-approved 2026-07-09, topic 29723: *"i approve the live-insights design spec with your recommendations."*). This is an approved DESIGN doc, not a converged spec; the /instar-dev tier reflects that.
Build branch: `echo/dashboard-live-insights` off `upstream/main` @ v1.3.792.
Tier: **1** (a new, dev-gated-dark, awareness-only READ surface; no irreversible action, no external egress, no money authority).

## Phase 1 — Principle check (signal vs authority)

**Does this change involve a decision point / authority?** NO. The feature is
strictly **awareness-only**. Its entire output is display text (a headline + lines +
legible metrics). It carries **zero action authority**:
- It NEVER gates, blocks, delays, or rewrites any message or operation.
- It NEVER mutates state — every route is a GET; the engine only reads.
- The one "action" it offers is a plain deep-link to a normal dashboard tab; that tab's
  own already-guarded controls (PIN / coherence / external-op gates) are unchanged and
  remain the only authority for anything mutating. The insight can never arm a door,
  send a message, or approve anything.

**Signal-vs-authority shape:** the LLM insight is a pure SIGNAL. The deterministic
one-liner floor is the always-available honest fallback. Neither is an authority. This
is the correct shape for a digestibility surface — it informs; it never decides.

## Phase 2 — Plan (build location + interactions)

- **Build location:** FRESH worktree `echo-dashboard-live-insights` off `upstream/main`
  @ v1.3.792 (per the AGENT-WORKTREE-CONVENTION-SPEC; the agent-home checkout on
  `echo/serve-main` is ~127 commits behind canonical). git remote = JKHeadley; per-worktree
  identity set by `instar worktree create`.
- **Re-grounding against main (all confirmed present):** `resolveDevAgentGate`
  (`src/core/devAgentGate.ts`) + the `DEV_GATED_FEATURES` registry + its both-sides wiring
  test (`devGatedFeatures-wiring.test.ts`); the shared `IntelligenceProvider`/`IntelligenceRouter`
  funnel with `attribution.component` auto-recording into `FeatureMetricsLedger` via the
  CircuitBreakingIntelligenceProvider tap; the nature-router maps
  (`LLM_ROUTING_NATURE` non-exhaustive, `LLM_ROUTING_INJECTION_EXPOSURE`, `LLM_UNTRUSTED_INPUT`,
  `LLM_BENCH_COVERAGE`, `COMPONENT_CATEGORY`) + their ratchets; the Process Health tab as the
  calm read-surface precedent; the Dashboard UX Standard F1–F8 floors + their static tests;
  `migrateConfigRoutingSpendDark` as the dev-gate config-seed migration precedent.

## Phase 3 — Side-effects enumeration

**New files (additive):**
- `src/monitoring/DashboardInsightEngine.ts` — the engine (deterministic floor + LLM layer + TTL cache).
- `src/monitoring/dashboardInsightCollectors.ts` — the built-in page collectors (LLM Activity wired).
- `tests/unit/dashboard-insight-engine.test.ts`, `tests/integration/insights-routes.test.ts`, `tests/e2e/insights-alive.test.ts`, `tests/unit/PostUpdateMigrator-dashboardLiveInsights.test.ts`.
- Docs: `docs/specs/dashboard-live-insights.md` (design authority, copied in), `.eli16.md`, `upgrades/next/…`, this file.

**Edited files (surgical, additive):**
- `src/server/routes.ts` — new `RouteContext.dashboardInsightEngine?` field + 3 GET routes (503 when null). No existing route touched.
- `src/server/AgentServer.ts` — new private field + dev-gate construction (own try/catch, cannot cascade) + one ctx-assembly line. Mirrors the `growthMilestoneAnalyst` precedent.
- `src/core/types.ts` — `DashboardConfig.liveInsights?` + `LiveInsightsConfig` (new optional shape).
- `src/config/ConfigDefaults.ts` — new `dashboard.liveInsights` default block (OMITS `enabled`; `dryRun:true`). Add-missing deep-merge; never clobbers `dashboard.fileViewer`/`poolStream`.
- `src/core/componentCategories.ts` — `DashboardInsightEngine: 'reflector'`.
- `src/data/llmBenchCoverage.ts` — bench `{exempt}`, injection `exposed(ALL)`, untrusted `true`. NOT added to `LLM_ROUTING_NATURE` (cite-the-bench forbids a nature row for an exempt component — the call rides the shared router's fast tier + declares `nature:'A'`, ready to graduate to a FAST-chain row when a bench task is authored).
- `src/core/devGatedFeatures.ts` — `dashboardLiveInsights` registry entry.
- `src/core/PostUpdateMigrator.ts` — `migrateConfigDashboardLiveInsightsDevGate` + runner registration.
- `src/server/CapabilityIndex.ts` — `/insights` prefix classified (surfaces in `/capabilities`).
- `src/scaffold/templates.ts` — CLAUDE.md "Live Insights (Dashboard Tab)" capability section (Agent Awareness).
- `dashboard/index.html` — nav button + panel + TAB_REGISTRY entry + `loadInsights()` (F1–F8 compliant).
- `tests/unit/llm-bench-coverage-ratchet.test.ts` — `DashboardInsightEngine` added to the pinned `EXEMPT_BASELINE` (a visible, reviewed act, per the ratchet's contract).
- `tests/unit/lint-dev-agent-dark-gate.test.ts` — line-number remap (+17) of the `EXPECTED` config-defaults snapshot. My block OMITS `enabled`, so the path SET is unchanged (still 25 entries) — pure line shift, re-verified.

**Migration parity:** existing agents get the config block + normalization via
`migrateConfigDashboardLiveInsightsDevGate` (idempotent, existence-checked, never writes
`enabled`, preserves an operator fleet-flip + sibling dashboard blocks); the CLAUDE.md
capability via the template; the routes via the shipped code.

**Cost / spend:** the ONLY cost path is the LLM insight call, and it is quadruple-bounded:
(1) it never fires while `dryRun` holds (dev default); (2) it fires only on `GET /insights*`,
never on a background sweep; (3) it is snapshot-fingerprint-cached (default 5 min) so a
polling dashboard re-spends at most once per page per TTL; (4) it rides the shared funnel's
host spawn-cap + circuit breaker, and is metered in `feature_metrics` (Token-Audit
Completeness — an unmetered LLM call is an unaccountable one).

**Untrusted-input safety:** page data (which can embed user/peer-authored rows) is
sanitized, length-clamped, and wrapped in a `<untrusted-page-data>` envelope that tells
the model it is data, never instructions; the component is `injectionExposed:true` so the
walk never routes it onto a non-injection door; the parsed output is treated as text only
(severity enum-clamped, unknown fields dropped, HTML-escaped at render).

## Phase 4 — Failure modes + rollback

- **LLM slow/failed/unparseable** → degrade to the deterministic floor (recorded, never
  silent; never throws to the route; never fabricates).
- **Collector throws / returns null / stale** → honest empty/paused state (F6), never a blank.
- **Engine construction throws** → own try/catch sets the engine null → routes 503 (dark
  contract), server boot unaffected.
- **Rollback lever:** unset/false `dashboard.liveInsights.enabled` (fleet) or set
  `dryRun:true` (dev) — read live at construction; a server restart reverts to byte-identical
  prior behavior (the tab 503s; no other surface changes). No data written that needs undoing.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

This change touches an operator surface (`dashboard/index.html` — the new Insights tab).

1. **Leads with the primary action?** YES. The tab's purpose is *reading the insights*,
   and the Insight Strips ARE the primary content — they render immediately on tab open
   (below the one-line purpose sentence), each with its "Open <page>" drill-in button
   visible on the card. Nothing the operator came for is behind a toggle or below the fold;
   the raw metrics are the ONLY thing collapsed (behind a "Show the data" disclosure), which
   is correct progressive disclosure — the plain-English takeaway leads, the numbers are opt-in.
2. **Zero raw internals as primary content?** YES. The headline and lines are plain English
   (an LLM/deterministic sentence). No JSON, fingerprints, UUIDs, hashes, or slugs appear as
   headline content. The only identifiers are the small muted source badge ("AI" / "summary" /
   "cached" / "paused") and the "as of <time>" stamp — support metadata, de-emphasized.
3. **Destructive actions de-emphasized?** N/A — the surface has NO destructive (or any
   mutating) action by construction. Its only interactive control is the "Open <page>"
   drill-in button (navigation) and a "Show the data" disclosure. There is nothing to
   revoke/delete/stop here.
4. **Plain language + phone width?** YES. Labels read the way a non-engineer would ("Live
   insights aren't turned on for this agent yet", "Couldn't load insights just now"). The
   strip uses the same `ph-root` responsive layout as the Process Health tab; metrics use a
   `repeat(auto-fit,minmax(120px,1fr))` grid that stacks at phone width; there is no fixed-
   width table and no horizontal scroll (F4). The dark state and error state render as calm
   sentences, never a raw error or a blank.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN — pure per-machine observability.** The Insight Strip summarizes
THIS machine's own dashboard-page data (its `FeatureMetricsLedger`, its live state). Each
machine's dashboard shows its own machine's insights — there is nothing to replicate and it
should differ per machine (a machine's routing health is that machine's). It emits NO
user-facing notices (no one-voice gating needed — it never sends; it only renders when the
operator opens the tab), holds NO durable state (the TTL cache is in-memory, per-process; it
strands nothing on a topic transfer), and generates NO URLs that cross machine boundaries
(the only link is an intra-dashboard `switchTab`). A pool-scope (`?scope=pool`) merged view
across machines is a natural future enhancement, not required for correctness — a
single-machine or per-machine read is the honest, correct default here.

## Phase 5 — Deferred (tracked follow-ups, honest)

- Increment C (cross-page Attention digest, JUDGE lane, optional default landing view).
- Increment D (gate-guarded action deep-links).
- Additional page collectors (Spend / Machines / Sessions / Attention) — the engine/route/UI
  are page-generic; each is a small additive collector. This ship wires LLM Activity as the
  proven end-to-end example.
- A `LLM_ROUTING_NATURE` row for `DashboardInsightEngine` once a real INSTAR-Bench task for
  the insight summarizer is authored (graduating it from `{exempt}` to `{task}` — cite-the-bench).
