# DX & API Design Review — Dashboard Observability (Jobs, Health, Agent Insights)

**Review ID:** 20260320-113858
**Round:** 1
**Reviewer Role:** Developer Experience & API Design Specialist
**Date:** 2026-03-20
**Spec:** `/Users/justin/.instar/agents/echo/specs/dashboard-observability.md`

---

## Approval Status: CONDITIONAL

The spec is well-conceived and solves a real problem — autonomous infrastructure that is completely invisible is a genuine failure mode, and the health-check spawn-error scenario cited is a compelling motivating example. The core design decisions are sound. However, several DX gaps could frustrate adoption, and a handful of API design choices need clarification or hardening before implementation begins.

---

## Research Findings

### Monitoring Dashboard UX Patterns (Grafana, Datadog, Vercel)

**Grafana:** Emphasizes information density over decoration — packs maximum signal into minimum space. Uses compact status rows, color-coded health indicators (green/yellow/red), and sparklines to show trend without requiring a chart. The sidebar-with-detail pattern for viewing entities (like jobs) is a well-established Grafana convention users already understand.

**Datadog:** Prioritizes time-to-value. Pre-built dashboards with 1000+ integrations mean first-run value in under 5 minutes. Status pages and alert feeds surface problems at the top. The key DX insight: users shouldn't need to hunt — failing things should visually rise to the top automatically.

**Vercel:** Developer-centric DX principles that are directly applicable here:
- Performance is design — avoid loading spinners; prefer skeleton screens and optimistic UI.
- Empty states show actionable commands in monospace (copy-friendly), not decorative illustrations.
- No-transition states — instant feedback, never make the developer wait wondering if something happened.
- Status reflected in browser tab (favicon/title changes) so multiple dashboards can be monitored across tabs.

**Best Practices for Job/Scheduler Monitoring:**
- Traffic-light status system (green/yellow/red) is universally understood — no legend needed.
- Problems must float to the top automatically — sorting by health status is table stakes.
- Run history as a heatmap/sparkline gives instant temporal pattern recognition (stability vs flapping vs degrading).
- Relative timestamps ("5m ago") are better than absolute for recent events; absolute timestamps must be available on hover.

**Mobile-First Patterns:**
- Show only top 3-4 KPIs as large tappable cards on mobile; collapse everything else.
- Replace complex tables with sparkline-style micro-visualizations in cards.
- Bottom navigation bar for key tabs; top nav for status/notifications.
- Back-button pattern for detail views (replacing the detail panel, not overlaying it) is correct on mobile.

**Information Density:**
- F and Z scan patterns mean critical status should live top-left.
- The vital signs strip across the top is the correct placement — top horizontal strips are the highest-attention real estate on a monitoring dashboard.
- Data density over decoration: this spec explicitly cites this principle — it is correct.

---

## Critical Issues

These are DX problems that, if unaddressed, block adoption or create confusion.

### 1. The Vital Signs Strip Has No Drill-Down Spec for "Degraded" States

The spec says "clicking any indicator switches to the relevant tab." But for Memory Pressure and Disk, there is no dedicated tab in Phase 1 — these link to nothing until Phase 3. A user clicks the orange "Disk 97%" indicator and lands on... the Jobs tab? Or goes nowhere? This creates a broken affordance: clickable UI elements that don't do what users expect.

**Required resolution:** Either (a) disable click behavior for indicators whose destination tab doesn't exist yet, with a tooltip like "Health tab coming in Phase 3," or (b) make the strip non-clickable until the target exists, or (c) expand Phase 1 to include a minimal Health tab stub.

### 2. Authentication Gap: First-Run Experience is Undefined

The spec assumes the user is already authenticated. But a new user hitting the dashboard for the first time needs to unlock it with a PIN. There is zero documentation of what the new Jobs tab, vital signs strip, or attention queue look like behind the auth wall — do they render as empty/locked? Is the vital signs strip visible before auth (since `/health` is public)?

The `/health` endpoint is explicitly described as public (no auth token required). The vital signs strip uses `/health`. This means the strip COULD show real system data before the user has authenticated, which could be a security concern (leaking server status to unauthenticated visitors) or a deliberate design choice (show health to encourage login).

**Required resolution:** Explicitly spec the pre-auth state for each new component.

### 3. Run History API Parameter is Speculative ("may need")

The spec says `GET /jobs/history?slug=<slug>&limit=50` then notes this parameter "may need" to be added. This is a frontend spec that depends on a backend API that may not exist. If the `?slug=` filter isn't implemented before the frontend, the Jobs detail view either loads all history and filters client-side (performance problem with large ledgers) or shows no history.

**Required resolution:** Confirm the `?slug=` param exists before building the detail view, or explicitly spec a client-side fallback.

### 4. "Run Now" Feedback Loop is Incomplete

The spec says the "Run Now" button shows a spinner and "When complete, auto-refreshes the history and state." But how does the frontend know the job is complete? Options:
- Poll `/jobs/:slug` state every N seconds until it transitions from running to success/failure (polling latency, complexity)
- WebSocket event (not yet specced for jobs)
- `POST /jobs/:slug/run` blocks and returns the result (synchronous, problematic for long-running jobs)

None of these are specified. A job can run for 75 seconds (visible in the example history). A spinner for 75 seconds with no intermediate feedback will cause users to assume it's broken and click again, creating duplicate runs.

**Required resolution:** Specify the feedback mechanism. Recommend: optimistic UI showing "Running..." with elapsed timer, polling state at 2s intervals, and a timeout message if not complete in 120s.

### 5. Empty State for Reports Sub-View is Missing

The spec has an empty state for the Jobs tab but not for the Reports sub-view. The most common state a user will see when first using Reports is an empty or near-empty view — the first several job runs may predate the feature, or job outputs may not be persisted. The spec explicitly leaves "job output persistence" as an open question (Open Question 1), which means the Reports view might frequently show blank cards or truncated data.

**Required resolution:** Spec the empty/partial state for Reports explicitly. If output persistence isn't decided, don't ship the Reports sub-view — it will underdeliver on its promise.

---

## Recommendations

These are improvements that significantly improve DX and should be resolved before or during implementation.

### R1. Add Timestamp Hover Behavior Explicitly

The spec shows relative times ("2m ago", "in 3m") everywhere. Best practice (Grafana, GitHub, Linear) is: relative time visible, absolute time on hover. This should be stated explicitly in the spec as a requirement, not left to implementer discretion. Without it, users debugging time-sensitive failures won't be able to correlate events with external logs.

### R2. Tab Count Badge Needs a Loading State

The Jobs tab badge shows "23" (total enabled jobs). During the initial fetch, what does it show? A blank badge is jarring. Specify: show nothing (no badge) until data loads, then populate it. Or show a skeleton/pulse state.

### R3. Cron-to-Human Converter: Spec the Failure Mode

The spec provides 7 example conversions but doesn't address what happens with unusual or complex cron expressions (e.g., `0 0 1,15 * *` — "1st and 15th of the month"). The converter must either handle these gracefully (show the raw cron expression as fallback) or the spec should constrain job schedules to only the patterns it supports. Showing a broken or confusing string is worse than showing the raw cron.

**Recommendation:** Fallback to raw cron expression with a tooltip explaining it when the converter doesn't recognize the pattern.

### R4. The Attention Queue Placement Decision Should Be Resolved, Not Deferred

Open Question 4 asks: "header badge + slide-out" vs "dedicated tab." This is an information architecture decision that affects the entire tab structure. If it's a tab, it affects the tab overflow problem (Open Question 3). Leaving this to Phase 2 without a resolution means Phase 1 header design may need to be reworked.

**Recommendation:** Make the attention queue a header badge + slide-out. Rationale: attention items demand immediate visibility without requiring a tab switch. A dedicated tab buries urgency. The spec's own Phase 2 design shows the bell icon pattern — that's the right answer. Commit to it now.

### R5. WebSocket Job Events Should Be Phase 1, Not a Stretch Goal

The spec mentions real-time job events via WebSocket as an open question and falls back to polling as the default. But polling at 30-second intervals means a job can fail and the user won't know for up to 30 seconds. For a monitoring dashboard, this is significant lag. The existing WebSocket for session events already proves the infrastructure works. Adding job events (`job_started`, `job_completed`, `job_failed`) to the protocol is low complexity but high value.

**Recommendation:** Treat WebSocket job events as Phase 1, not a stretch goal. The 30s polling fallback can remain for resilience, but real-time events should be the primary update path.

### R6. Mobile Tab Overflow Needs a Decision Before Phase 1 Ships

The spec notes (Open Question 3) that adding more tabs creates overflow. This is not a future problem — it starts in Phase 1. Even adding one Jobs tab changes the tab bar from 3 to 4 items, and on narrow mobile screens (320-375px) 4 tabs can already cause overflow depending on label length. "Drop Zone" alone is 9 characters.

**Recommendation:** Implement a tab overflow strategy now — either horizontal scrolling tabs (simplest), or a bottom-nav pattern on mobile that replaces the tab bar entirely. A "System" dropdown grouping future tabs (Health, Evolution, Autonomy) is a good forward-compatible solution.

---

## Observations

Nice-to-have enhancements that would improve the experience but are not blockers.

**O1. Favicon/Title Reflection (Vercel Pattern):** When any job is failing or health is degraded, update the browser tab title to include a status indicator (e.g., "⚠ 1 failing — Instar Dashboard"). This lets users monitor without keeping the tab active. Low implementation cost, high operational value.

**O2. Keyboard Navigation for Job List:** Power users will want to navigate the job list with arrow keys and hit Enter to open detail. The two-panel layout maps well to keyboard navigation. Worth speccing even if not Phase 1.

**O3. Copy Button for Error Messages:** The "Error: Max sessions (3) reached" in the current state card will need to be copied for debugging. An inline copy button on error text follows developer tooling conventions (Vercel, Netlify) and reduces friction.

**O4. "Last successful run" in Addition to "Last run":** When a job is currently failing, the most useful contextual information is when it last succeeded — this tells the user how long the problem has been going on. The current spec shows "Last Run: 5m ago" but doesn't distinguish a failing run from a successful one. Add "Last success: 45m ago" to the current state card.

**O5. "Run Now" Should Require Confirmation for Critical Jobs:** The spec has a confirmation prompt for disabling critical jobs but not for triggering immediate runs. For a critical job like `health-check`, a misfire run-now during session saturation will immediately fail and increment the consecutive failure counter. A tooltip warning is appropriate.

**O6. Job History Pagination vs. Infinite Scroll:** The spec specifies `limit=50` for history but doesn't address loading older runs. If the user wants to investigate an incident from yesterday, they can't. Either pagination controls ("Load 50 more") or lazy infinite scroll should be specced.

**O7. Accessibility: Color-Only Status is Insufficient:** The spec uses colored dots (green/orange/red) as the primary status indicator. Users with red-green color blindness (8% of males) need a secondary indicator — icon shape, text label, or pattern fill. The existing `.session-status` CSS should be checked for how it handles this.

---

## Scalability Assessment

### DX as Platform Grows

**Tab Proliferation (High Risk):** The spec plans Health, Evolution, and Autonomy as Phase 3 additions. That's 7 tabs total. Modern dashboard research consistently shows that 5+ tabs at a flat level degrades navigation. The "System" dropdown grouping idea (Open Question 3) must be planned into the navigation architecture now — retrofitting it after 7 tabs are built is painful.

**Monolithic HTML (Medium Risk):** The spec notes all frontend changes go into a single `index.html` (~102KB, growing to ~155KB estimated). This is fine for now but creates friction as the system grows: slow to iterate, hard to review, risky to merge. The no-build-step constraint is understandable but an explicit size budget (e.g., "cap at 200KB") and module conventions (well-commented section delimiters) would reduce long-term maintenance pain.

**Polling Load (Low Risk, Watchable):** At 30-second polling for `/health` and `/jobs`, with the dashboard open in one browser, the server sees 4 requests/minute. This is trivial. But if multiple instances are open (multiple team members, multiple machines), polling multiplies. The WebSocket upgrade path (Recommendation R5) eliminates this entirely and should be treated as a scalability investment.

**API Surface Growth (Low Risk):** The 5 new server endpoints are all well-scoped and RESTful. The `PATCH /jobs/:slug` pattern is consistent with existing conventions. No concerns here — the API is clean.

**History Retention (Medium Risk):** Open Question 5 (unbounded ledger growth) is the most pressing operational concern. A dashboard that shows history is only as good as the history it can query. Without retention policy, the `/jobs/history` endpoint will eventually slow, and the dashboard's run history table will become unwieldy. Cap at 500 runs per job with time-based pruning as a reasonable starting point.

---

## Score: 7.5 / 10

**Justification:**

**Strong:** The problem statement is crisp and the motivating example (8 consecutive spawn-errors nobody saw) is exactly right. The design is coherent, the phased approach is pragmatic, and the UX principles (data density, problems float to top, lazy loading, no external dependencies) are all correct. The spec shows strong operational awareness — written by someone who actually uses the system and understands what information they need.

**Deducted:** The critical issues (broken drill-down affordances, undefined auth state, speculative API dependencies, incomplete feedback loops) are real gaps that will cause either developer confusion during implementation or user frustration at runtime. The open questions that directly affect Phase 1 structure (attention queue placement, tab overflow) should be decided, not deferred. The Reports sub-view is undercooked given the unresolved output persistence question and should be explicitly labeled as blocked pending that decision.

**With the 5 critical issues resolved and R4/R5/R6 acted on, this spec reaches 9/10 — it is a well-scoped, high-value addition to the dashboard.**
