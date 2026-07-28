---
title: "Dashboard Live-Insights + Digestibility Layer (design)"
slug: "dashboard-live-insights"
author: "echo"
status: "approved — Increment A+B built"
parent-principle: "UX & Agent Agency Standard — Rule 3 (The Agent Gets a Voice) + Axis 1 (Minimal/Progressive/Recoverable/Complete)"
created: "2026-07-09"
topic: 29723
approved: "2026-07-09 (operator, topic 29723): 'i approve the live-insights design spec with your recommendations.'"
note: "Operator-approved design doc. This PR builds Increment A (the deterministic Insight Strip + per-page one-liner floor) + Increment B (LLM insight via the shared nature-router FAST lane, cached, awareness-only), dev-gated dark. Increment C (cross-page Attention digest / default landing) and D (gate-guarded action buttons) are tracked follow-ups. Additional page collectors beyond LLM Activity are additive follow-ups (the engine/route/UI are page-generic)."
---

# Dashboard Live-Insights + Digestibility Layer

## Problem / operator goals
Justin (2026-07-09, topic 29723): the dashboard should be **extremely digestible, clearly actionable, ELI16-simple with clear paths to drill into details, and carry a built-in live-LLM-insights feature per page** — one that reads the page's own data, surfaces active insights, and uses our benchmark data to pick the best model per insight.

Tonight's 8-floor **Dashboard UX Standard** (`docs/specs/dashboard-ux-standard.md`) fixed the STRUCTURE (reachable, labeled, responsive, self-explaining). This is the NEXT layer: turning 25 tabs of raw data into **at-a-glance meaning + a next step**. The "~732 errors" headline (Task-2 finding) is the exact failure this fixes — a raw number that conflates a mesh-probe with one real LLM issue, telling the operator nothing about what to DO.

## Grounding (our own established UX doctrine — this is not new philosophy)
- **UX & Agent Agency Standard, Rule 3 (The Agent Gets a Voice):** "the agent notices degraded states (offline machines, stale jobs, inactive users) and surfaces them proactively." Live-insights is that rule, made a first-class page feature.
- **Rule 1 (No Dead Ends):** every insight ends with what to DO, never just a stat.
- **Axis 1 — Progressive:** headline insight first; detail revealed on drill-in only when wanted (ELI16 + drill-down).
- **Process Health tab precedent** (`PROCESS-HEALTH-DASHBOARD-TAB-SPEC.md`): the proven digestible read-surface — calm, plain English, no monospace/config-keys, an *informational* headline (not an auto-alarm), staleness→"Connection paused", strict sanitize-untrusted-data render safety, awareness-only (no action authority). Reuse this contract verbatim.

## The design

### 1. The Insight Strip (per-page, shared component)
A single calm card pinned at the top of each tab, BELOW the F3 purpose line:
- **Headline (ELI16):** 1 plain-English sentence — the single most important thing about this page's current data. e.g. Spend tab: "Nothing is spending — all paid doors are off and $0." · LLM Activity: "Routing is healthy; one check (TopicIntentExtractor) is failing 28% of the time and is worth a look." · Machines: "Your Mac Mini is unreachable right now — the laptop is serving."
- **1-3 supporting insight lines**, each with an **action** (Rule 1): a plain next step, and where the action is safe + in-scope, a button that deep-links to the relevant tab/filter or triggers an already-PIN/gate-guarded operation (never a new unguarded power).
- **Drill-in:** "Show the data" expands the raw numbers/rows the insight is drawn from (progressive disclosure). The insight never REPLACES the data — it sits above it.
- **Freshness:** each strip shows "as of <t>"; on stale/unreachable data it degrades to "Insights paused — data unavailable" (Process Health staleness contract), never a confident-but-stale claim.

### 2. Model selection via the EXISTING nature-axis routing (the elegant reuse)
Insight generation is just another internal LLM call — so route it through the nature-router (`docs/specs/nature-axis-routing.md`) that the benchmark data already tuned:
- **FAST lane** (gpt-5.4-mini / flash-lite): a single-page factual summary / anomaly flag (most insights). Cheap, quick.
- **JUDGE lane** (gpt-5.5): a cross-page synthesis / "what needs my attention" digest, or an insight requiring real reasoning.
- The insight component declares its `nature` (A=FAST for a page summary, B=JUDGE for synthesis) and lets the router pick door+model from the tuned chains. **No new model-selection logic** — the benchmark-driven chains ARE the "pick the best model per insight." This also means insights inherit the injection-safety map (page data is untrusted input → the router already routes untrusted-input components to injection-safe doors).

### 3. The "Attention" digest (top-level, cross-page)
One JUDGE-lane synthesis (opt-in, cadenced or on-dashboard-open) that reads the per-page insight headlines + the existing Attention queue / guard posture / reap-log and produces the operator's **"here's what needs you"** list — the single most digestible surface. Ends each item with a one-tap path. This is the antidote to 25 tabs: the operator reads ONE list first, drills only where flagged.

### 4. Safety + cost contract (non-negotiable, mostly inherited)
- **Untrusted-data:** page data (and especially anything user/peer-authored — relationships, threadline, commitments) is DATA, never instructions to the insight LLM. Sanitize + envelope (reuse the Process Health / navigator untrusted-data contract). The insight is **advisory/awareness-only — zero action authority**; any button it offers routes through the existing gate for that action (PIN for money, coherence/external-op gates for actions). An insight can never arm a door, send a message, or mutate state on its own.
- **Cost-bounded:** insights generate **on view + cache** (TTL, e.g. 5-15 min), NOT continuous polling. Bounded by the host spawn cap + a per-insight token budget + the daily internal-LLM spend view (`/routing-spend`). Off-Claude by default (via routing). A page with unchanged data serves the cached insight (no re-spend).
- **Observable:** every insight call flows through `feature_metrics` (per-feature LLM metrics) like every other internal call — so its cost/error/model is auditable in the LLM Activity tab (dogfooding).
- **Honest maturation:** ships DARK/dev-gated (observe-only: generate + log insights, render nothing) → dev-live → fleet, per the graduated-rollout ladder. Never dark-shipped-as-done.

### 5. Digestibility/actionability improvements (prioritized, independent of the LLM feature)
1. **Reframe the LLM Activity error count** (Task-2 finding): separate non-LLM rows (mesh rope-probe) from real LLM-routing errors so the number reflects genuine routing health. Cheap, high-clarity.
2. **Per-tab "what this means" one-liner** derived from the data even without the LLM (a deterministic template), as the always-on floor beneath the LLM strip — so digestibility survives the LLM being off/dark.
3. **The Attention digest (§3)** as the dashboard's default landing view — "what needs you" before the tab grid.
4. **Consistent empty/healthy states** that say "all good" affirmatively (not a blank), per F6.
5. **Numbers carry their unit + trend** (▲/▼ vs last period) so a value is instantly legible.

## Increments (for a future build, operator-gated)
- **A (dark):** the Insight Strip component + the deterministic per-page one-liner (§5.2) — no LLM yet, pure digestibility. Ships useful immediately.
- **B (dev-live):** LLM insight generation via the nature-router (FAST-lane page summaries), cached, observable, awareness-only.
- **C:** the cross-page Attention digest (JUDGE-lane) + default landing view.
- **D:** action deep-links / gate-guarded action buttons.

## Open questions for the operator
1. Insight refresh: on-view+cache (my recommendation — cheapest, always-fresh-enough) vs a background cadence vs a manual "refresh insights" button?
2. Landing view: make the cross-page Attention digest the default dashboard view, or keep it as its own tab / a top strip?
3. Cost posture: insights off-Claude by default (pi/codex) is cheapest; do you want a "use the strongest model for insights" toggle for a given page (routes JUDGE-lane)?
