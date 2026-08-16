# Architecture Review: Dashboard Observability — Jobs, Health, and Agent Insights

**Review ID:** 20260320-113858
**Spec:** dashboard-observability.md
**Round:** 1
**Reviewer:** Echo (systems architect mode)
**Date:** 2026-03-20

---

## Approval Status

**CONDITIONAL**

The architecture is fundamentally sound and the problem is real. The spec is well-grounded in existing infrastructure and the phased approach shows good judgment. Two conditional issues need resolution before implementation begins — neither is a blocker by itself, but together they represent meaningful technical debt if unaddressed. The rest is executable as written.

---

## Research Findings

### Vanilla JS Monolithic Dashboard — The Tipping Point

Research into dashboard complexity management confirms a consistent industry pattern: vanilla JS monoliths work well up to roughly 2,000–3,000 lines, then maintenance cost rises superlinearly as state management sprawls. The current dashboard is already at 3,512 lines and the spec proposes adding ~950 more lines (300 CSS + 150 HTML + 500 JS). That puts the file at ~4,500 lines.

The academic threshold doesn't define the real problem. The real problem is the `switchTab()` function — it's a direct-manipulation imperative block that names every tab div explicitly. Adding each new tab requires editing that function, the HTML, and potentially global state variables. This is the classic "list in three places" anti-pattern. By the time Phase 3 (Health, Evolution, Autonomy tabs) ships, `switchTab()` will have 7+ branches, global state will have grown substantially, and the file will be difficult to navigate and modify without introducing regressions.

Lightweight alternatives (Svelte, Solid.js, Vue) were researched but are definitively ruled out by the spec's no-build-step constraint. That constraint is correct for this project. The right answer is not a framework — it's an architectural pattern applied to vanilla JS: a data-driven tab registry instead of imperative branches.

### WebSocket vs. Polling for Job Monitoring

Research confirms the hybrid architecture is the practical winner for dashboards like this. The pattern used by CloudWatch, Stripe, and others: push (WebSocket) for state-change events, pull (polling) for bulk/initial data. The spec proposes exactly this hybrid (poll `/jobs` every 30s, use WebSocket for real-time updates if available). This is correct.

The key finding relevant to this spec: the existing WebSocket's `onmessage` handler is being monkey-patched in at least one place (Drop Zone, line 3497–3500). This ad-hoc extension pattern does not scale. Adding job events to the WebSocket will be messy unless the message dispatch is refactored into a proper event registry first.

### Tab Overflow Navigation

Research confirms that 5–6 tabs is the practical maximum for a flat tab bar before it becomes a UX problem, particularly on mobile. The spec acknowledges this in Open Question #3 but doesn't resolve it. Phase 3 would create 7 tabs (Sessions, Files, Drop Zone, Jobs, Health, Evolution, Autonomy). NN/G recommends switching to hierarchical navigation or a sidebar at this threshold. The spec's proposed "System" dropdown grouping is a pragmatic middle ground — it should be decided and committed to now, not deferred, because it affects the HTML structure for every new tab.

### Agent Observability UI Patterns

The OpenTelemetry GenAI observability standards emerging in 2025–2026 identify four essential views for agent observability: metrics (aggregated), traces (execution flow), logs (decisions and tool calls), and evaluations (quality). The spec covers metrics (vital signs, job health) and logs (run history, operation log) but has no trace view. This isn't a gap that needs to be filled now — it's context for the evolution roadmap.

The "problems float to the top" principle in the spec aligns directly with industry best practice for operational dashboards (Grafana's approach, Datadog's alert-first sorting). Confirmed correct.

---

## Critical Issues

### 1. Tab System Does Not Scale to Phase 3 (Architecture Debt)

**Severity:** Medium — not a blocker for Phase 1, but becomes a blocker by Phase 3 if unaddressed.

The current `switchTab()` function manually names every tab container element and shows/hides them by ID. Adding each new tab requires editing three places: the HTML tab button, the HTML content div, and the `switchTab()` switch-case block. The spec adds 1 tab in Phase 1, 1 panel in Phase 2, and 3 tabs in Phase 3 — a total of 5 additions. If implemented as-is, `switchTab()` will have ~8 explicit branches and the file's global state will grow correspondingly.

**Recommended fix:** Before implementing new tabs, refactor `switchTab()` to be data-driven:

```javascript
// Tab registry — add a tab by adding one entry here
const TAB_REGISTRY = {
  sessions: { containers: ['sessionsTab', 'mainPanel'], onActivate: null },
  files:    { containers: ['filesTab'], onActivate: () => { if (!fileTreeLoaded) loadFileTree(); } },
  dropzone: { containers: ['dropzoneTab'], onActivate: () => { loadDzSessions(); loadDzHistory(); } },
  jobs:     { containers: ['jobsTab'], onActivate: loadJobsTab },
};

function switchTab(tabName) {
  if (tabName === currentTab) return;
  currentTab = tabName;
  document.querySelectorAll('.tab-bar .tab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === tabName));
  Object.values(TAB_REGISTRY).forEach(t =>
    t.containers.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; }));
  const tab = TAB_REGISTRY[tabName];
  if (tab) {
    tab.containers.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = ''; });
    tab.onActivate?.();
  }
  updateFileUrl();
}
```

This is a 30-minute refactor that pays dividends across every subsequent phase.

### 2. WebSocket Message Dispatch Is Fragile

**Severity:** Medium — risk of silent regressions when job events are added.

The spec proposes using the existing WebSocket for real-time job updates. The current architecture has `ws.onmessage` assigned as a function, with at least one place (Drop Zone) adding a listener by monkey-patching it after assignment (`ws.addEventListener('message', ...)`). When `ws` reconnects (reconnection logic exists with exponential backoff), the monkey-patched listeners are lost because `connectWebSocket()` creates a new WebSocket object.

Adding job event types to a broken dispatch architecture will cause hard-to-debug issues: job events silently dropped after reconnect, or Drop Zone's paste events stopping on reconnect.

**Recommended fix:** Before adding job events, convert `ws.onmessage` to a publish-subscribe pattern:

```javascript
const wsListeners = {};
function wsOn(type, fn) {
  (wsListeners[type] ??= []).push(fn);
}
// In ws.onmessage:
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  (wsListeners[msg.type] ?? []).forEach(fn => fn(msg));
  (wsListeners['*'] ?? []).forEach(fn => fn(msg));
};
// Usage: wsOn('job_completed', handleJobCompleted);
// Drop Zone: wsOn('paste_created', handlePasteCreated);
```

This survives reconnections because listeners are registered in module-level setup, not inline on the ws object.

---

## Recommendations

### 1. Resolve Open Question #3 (Tab Overflow) Before Phase 1

The spec defers the tab overflow question. It should be decided now because it affects the HTML structure. The recommended answer: adopt a "System" tab group (dropdown or second-row grouping) as the container for Jobs, Health, Evolution, and Autonomy. Sessions, Files, and Drop Zone remain top-level. This keeps the tab bar at 4 items while giving the agent's internal systems a coherent home. Phase 1 can implement Jobs as a standalone tab temporarily with a comment marking it for regrouping — but the tab HTML structure should assume the group from the start.

### 2. Add Job History Retention Policy Before Building the UI

Open Question #5 (unbounded ledger growth) needs a decision before the Reports view (Phase 2) is built. The spec should specify a retention bound — either per-job (last N runs) or time-based (last 30 days). Without this, the Reports view's infinite-scroll pattern will become unusable as the ledger grows. Recommended: cap at 200 runs per job in the server-side ledger, truncating oldest on write. This is a 10-line server change that prevents a future data problem.

### 3. Make the Cron-to-Human Converter a Named Module

The spec proposes an inline JS function for cron parsing. This is correct (no dependency). However, cron parsing is non-trivial — the spec shows 7 examples but the full jobs config likely has edge cases (intervals with step values, day-of-week handling, etc.). Name it `parseCronHuman(expr)` and co-locate it with a suite of test cases as inline comments. This makes it easy to debug and extend without hunting through 4,500 lines of dashboard code.

### 4. Job "Run Now" Authentication and Response Contract

`POST /jobs/:slug/run` is a privileged action (triggers a live process). The spec correctly notes it needs server-side implementation. Ensure the endpoint:
- Requires the same Bearer token as other endpoints (not auth-free like `/health`)
- Returns 409 if the job is already running (not just disabling the button client-side)
- Returns 202 Accepted with a run ID, not 200 — the job runs async

The button's "auto-refresh when complete" behavior needs a polling loop on the run ID or a WebSocket job_completed event. The spec mentions both options but doesn't commit. Commit to WebSocket events if the message dispatch refactor (Critical Issue #2) is done; otherwise use polling as a fallback.

### 5. Vital Signs Strip Height Budget — Test Mobile Explicitly

The spec says the strip must not increase header height by more than ~8px. The proposed layout has 5 indicators with bars and labels at 11px font. On mobile, it collapses to icons-only. Test this constraint explicitly — dashboard headers at 8px additions sound fine but can feel cramped when the tab bar + strip + borders stack up on a 375px-wide phone screen. Consider 0px height increase on mobile (strip moves into the first tab, not the header) if the collapsed icon row doesn't fit cleanly.

---

## Observations

**The problem statement is unusually specific and grounded.** "Health-check had 8 consecutive spawn-errors today — nobody knew" is not a hypothetical. The spec is driven by a real operational gap, which means the success criteria are concrete and testable. This is a well-motivated spec.

**The phased approach is correct.** Phase 1 (vital signs + jobs) delivers 80% of the observability value. Phase 2 and 3 are genuine increments, not restated scope. The build order within Phase 1 (vital signs first, then job list, then detail) reflects good prioritization.

**The no-external-dependencies constraint is the right call.** At 3,500 lines, this dashboard is already pushing the single-file pattern's limits, but the trade-off (zero build toolchain, instant serve, works offline) is worth it for an agent's local tool. A sparkline in 20 lines of canvas code is genuinely simpler than pulling in Chart.js for this use case.

**Lazy loading is correctly specified.** Loading job history on-demand (not on tab open) is the right call. Twenty-three jobs x 50-run history = 1,150 history records on initial load if done eagerly. The spec avoids this.

**The attention queue header-vs-tab question (Open Question #4)** has a clear answer from the data: attention items are urgent, rare, and actionable. That's a header pattern (persistent badge, slide-out), not a tab pattern (destination navigation). The spec's own description of the slide-out panel confirms this. Close the question in favor of the header.

**Job output persistence (Open Question #1)** depends on whether Reports view (Phase 2) is actually needed. The run history table (result, error, duration) in Phase 1 already answers "what happened." The Reports view adds full session output — only useful if the agent's job outputs are diagnostic (e.g., "server healthy, disk 97%"). For Instar's current jobs, this is borderline useful. Deferring to Phase 2 is correct; persisting outputs to `.instar/ledger/job-outputs/` is the right mechanism when the time comes.

---

## Scalability Assessment

**Current scale:** 23 jobs, 1 agent, 1 server, local machine. The spec's polling-first approach (30s interval, lazy history) handles this with zero performance concerns.

**Near-term scale (100 jobs, Phase 3 tabs):** The `GET /jobs` response grows linearly with job count. At 100 jobs the response is still small (each job's state is a few hundred bytes). Virtual scrolling doesn't arise until ~500+ jobs. Not a concern for this project's foreseeable scope.

**Tab count scale:** As analyzed in Critical Issue #1, the real scalability concern is developer ergonomics, not runtime performance. The tab registry refactor addresses this. Without it, adding Phase 3's 3 tabs becomes a risky surgery on a large file.

**WebSocket message scale:** Job events add new message types but not volume. A job running every 5 minutes generates 1 event per run — negligible traffic. The dispatch architecture concern (Critical Issue #2) is about correctness, not scale.

**History retention scale:** Without a cap, the ledger is O(time x job_count). With 23 jobs running over months, this becomes a real disk and load concern. The 200-runs-per-job cap (Recommendation #2) bounds it at ~4,600 records total, roughly constant over time.

**Mobile scale:** The vital signs strip collapse pattern and the back-button navigation for job detail on mobile are well-specified. The attention panel slide-out on mobile needs explicit width handling (100% width, not the desktop 380px) — a minor CSS concern but worth noting.

---

## Score: 7.5 / 10

**Justification:**

The spec earns high marks for being grounded in real operational pain, proposing phased delivery that respects effort boundaries, designing consistently with existing patterns, and making correct calls on dependencies and UX principles. The API surface is well-mapped, the server additions are minimal and correctly estimated as low-complexity, and the success criteria are specific and testable.

Points deducted for:

- **Not resolving the tab overflow question** before starting Phase 1. This is a structural decision that should not be deferred.
- **Not acknowledging the `switchTab()` scaling problem.** A spec written by someone who will implement it should catch this.
- **Not specifying the WebSocket dispatch refactor** as a prerequisite for real-time job events.
- **Leaving history retention unbounded** without flagging it as a near-term operational risk.

None of these are fatal. They are design gaps that, left unaddressed, will slow down Phase 2 and Phase 3 more than Phase 1. The architecture is sound and the implementation path is clear. Resolve the two critical issues and three key recommendations before writing a line of Phase 2 code.
