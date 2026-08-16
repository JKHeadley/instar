# Spec: Dashboard Observability — Jobs, Health, and Agent Insights

**Author:** Echo
**Date:** 2026-03-20
**Status:** Draft (Rev 3 — post-crossreview)
**Scope:** New dashboard tabs and UI components for the Instar web dashboard
**Review:** SpecReview Round 1 — 8 reviewers, 7.0/10 avg, CONVERGING. CrossReview — GPT/Gemini/Grok, 8.6/10 avg, CONDITIONAL. All findings incorporated below.

---

## Problem

The Instar dashboard currently has three tabs: **Sessions**, **Files**, and **Drop Zone**. These cover interactive use — watching sessions, browsing files, pasting content. But the agent's autonomous infrastructure (23 scheduled jobs, health monitoring, evolution system, attention queue, trust/autonomy, memory) is completely invisible from the dashboard. The only way to see this data is to query API endpoints directly or ask the agent.

This means:
- A job can silently fail for hours (health-check had 8 consecutive spawn-errors today — nobody knew)
- System health degrades without any visual signal (disk at 97%, sessions maxed at 3/3)
- The agent's self-improvement, memory, and trust systems are opaque
- Attention queue items exist but aren't surfaced anywhere visual
- There's no way to understand what the agent has been *doing* autonomously

The agent has rich internal state. The dashboard should expose it.

---

## Current State

### Existing Dashboard
- **Tech:** Single `index.html` (~102KB), vanilla JS, dark theme, CSS grid layout
- **Tabs:** Sessions (terminal + session list), Files (tree browser + editor), Drop Zone (paste input)
- **Tab system:** `switchTab()` function, `data-tab` attributes, show/hide content divs
- **Real-time:** WebSocket (`/ws`) for session output streaming
- **Auth:** PIN-based unlock → bearer token
- **Mobile:** Responsive at 768px breakpoint

### Available API Endpoints (already implemented server-side)

| Endpoint | Returns |
|----------|---------|
| `GET /health` | Server status, uptime, sessions (current/max), memory, disk, job failures, system review |
| `GET /jobs` | All 23 jobs with config, schedule, state (lastRun, lastResult, consecutiveFailures, nextScheduled) |
| `GET /jobs/history?limit=N` | Run history: runId, slug, trigger, start/end, duration, result, error, model |
| `GET /monitoring/memory` | Memory pressure: percent, state, trend, thresholds |
| `GET /attention` | Attention queue items with priority, status, summary |
| `GET /autonomy/summary` | Current autonomy profile, trust levels, evolution mode |
| `GET /trust` | Per-service trust levels with maturity |
| `GET /evolution/proposals` | Self-improvement proposals with status |
| `GET /operations/log` | Operation gate decisions (allow/block/plan) |
| `GET /topic/stats` | Topic memory statistics |
| `GET /topic/list` | All conversation topics |

All endpoints require `Authorization: Bearer <token>` (except `/ping` — see Security section).

---

## Security Requirements

These requirements were identified by the SpecReview (Security, Adversarial, Privacy reviewers) and must be implemented **before any Phase 1 frontend code ships**.

### S1. Split `/health` into `/ping` + `/health` (auth-gated)

The current `/health` endpoint is unauthenticated and returns session counts, disk %, memory pressure, job failure details, and system review data. With Cloudflare tunnel active, this is internet-accessible — a reconnaissance gift.

**Change:**
- `GET /ping` — Public. Returns only `{"status":"ok"}`. Used by external uptime monitors.
- `GET /health` — Requires auth. Returns full operational detail (current response shape unchanged). The vital signs strip polls this endpoint post-login.

**Migration plan (Grok catch):** External monitors currently hitting `/health` will break when it becomes authenticated. Cutover strategy:
1. Phase 0: Add `/ping` as a new endpoint. `/health` continues to work without auth.
2. Phase 0 + 1 week: Add auth requirement to `/health`. Log any unauthenticated `/health` requests as warnings for 2 weeks.
3. Phase 0 + 3 weeks: Remove the warning log — `/health` returns `401` for unauthenticated requests.
4. Document the change in upgrade notes for any external integrations (e.g., UptimeRobot, Healthchecks.io) that may be hitting `/health`.

### S2. Rate Limits on Mutation Endpoints

`POST /jobs/:slug/run` is effectively a remote code execution primitive — it spawns Claude sessions with tool access. Without rate limits, a stolen token can exhaust API quota.

**Rules:**
- Max 1 manual trigger per job per schedule interval (e.g., health-check runs every 5 min → can only be manually triggered once per 5 min)
- Global cap: 5 concurrent manual triggers across all jobs
- Return `409 Conflict` if the job is already running
- Return `429 Too Many Requests` if rate limit exceeded
- All `Run Now` invocations logged to `.instar/security.jsonl`

### S3. Field Allow-List on PATCH Endpoints

`PATCH /jobs/:slug` must only accept `{ enabled: boolean }`. All other fields → `400 Bad Request`. Without this, a token holder could modify job schedules, models, or prompts.

`PATCH /attention/:id` must only accept `{ status: "ACKNOWLEDGED" }`.

### S4. CORS and HTTP Security Headers

- Add `PATCH` to CORS `Allow-Methods` header (currently missing — will break preflight for new endpoints)
- Add HTTP security headers on all dashboard responses:
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' cdn.jsdelivr.net; connect-src 'self'`
  - `Referrer-Policy: no-referrer`

**Note on CSP `'unsafe-inline'`:** The dashboard's JavaScript is inline in `index.html` (single-file architecture). A CSP without `'unsafe-inline'` would break the entire dashboard on load — a showstopper caught by GPT crossreview. Long-term, migrating to nonce-based CSP (`script-src 'nonce-<random>'`) is preferable. For Phase 1, `'unsafe-inline'` is the pragmatic choice. Phase 3 should investigate nonce-based CSP when the `<script>` tag is refactored. The `connect-src 'self'` directive is added to restrict fetch/SSE targets.

### S5. Input Validation

- Job slug parameters validated against `/^[a-z0-9-]+$/` to prevent path traversal and log injection
- All new HTML rendering must use `textContent` (not `innerHTML`) or the existing `escapeHtml()` function. Job error messages and handoff notes are LLM-generated and must be treated as untrusted input.

### S6. Dashboard Action Audit Log

All dashboard-initiated mutations (Run Now, Enable/Disable, Attention Dismiss/Acknowledge) logged to `.instar/security.jsonl` with timestamp, action, target, and source IP.

### S7. Phase 3 Elevated Auth (Future)

Evolution proposal approve/reject and autonomy profile changes require PIN re-entry (not just bearer token). This prevents a stolen token from modifying agent behavior. Implementation deferred to Phase 3 build.

### S8. Operation Log Sanitization (Future)

`GET /operations/log` must redact full operation parameters before rendering — show only decision + category. Prevents attackers from reverse-engineering the gate's rulebook. Implementation deferred to Phase 3 build.

### S9. Security Audit Log Rotation

`.instar/security.jsonl` needs a rotation policy to prevent disk exhaustion. Without one, heavy dashboard usage can grow this file unbounded.

**Policy:**
- Size cap: 10MB per file. Rotate to `security.1.jsonl`, keep last 3 rotations.
- Time-based: Entries older than 90 days trimmed on server startup and daily.
- Use existing `jsonl-truncator.ts` utility for rotation.
- Symmetric with the job history retention policy (A5).

---

## Architecture Decisions

Decisions resolved from SpecReview Round 1. These are binding for the implementation.

### A1. Tab System: Data-Driven Registry

The current `switchTab()` is imperative and names every tab container by ID. This doesn't scale to 7 tabs.

**Decision:** Refactor to a data-driven `TAB_REGISTRY` before adding the Jobs tab.

```javascript
const TAB_REGISTRY = [
  { id: 'sessions', label: 'Sessions', countEl: 'tabSessionCount', sidebar: 'sessionsTab', main: 'mainPanel' },
  { id: 'files', label: 'Files', sidebar: null, main: 'filesTab' },
  { id: 'dropzone', label: 'Drop Zone', sidebar: null, main: 'dropzoneTab' },
  { id: 'jobs', label: 'Jobs', countEl: 'tabJobCount', sidebar: 'jobsSidebar', main: 'jobsMain' },
];
```

`switchTab()` becomes a generic loop over the registry. Adding a new tab = adding one object to the array + the HTML containers.

### A2. Tab Overflow: "System" Dropdown Group

With Phase 3, we'd have 7 tabs: Sessions, Files, Drop Zone, Jobs, Health, Evolution, Autonomy. This overflows on mobile.

**Decision:** Group Phase 3 tabs under a "System" dropdown:
- Top-level tabs: `Sessions` | `Files` | `Drop Zone` | `Jobs` | `System ▾`
- System dropdown: Health, Evolution, Autonomy

This keeps the tab bar at 5 items max. The dropdown is implemented in Phase 1 (even if only Jobs is in it initially) to avoid HTML structure rework later.

### A3. Real-Time Events: SSE (not WebSocket)

The existing WebSocket dispatch (`ws.onmessage` assignment) is fragile — Drop Zone monkey-patches it, and listeners are silently lost on reconnect.

**Decision:** Use a new SSE endpoint for job events instead of extending WebSocket.

- `GET /jobs/events` — Server-Sent Events stream (auth required)
- Events: `job_started`, `job_completed`, `job_failed`, `job_state_changed`
- Each event carries: `{ slug, runId, result, timestamp, error? }`
- Dashboard subscribes on Jobs tab activation, closes on tab switch
- Fallback: 30s polling if SSE connection fails

This also requires refactoring WebSocket to a `wsOn(type, fn)` pub-sub pattern for existing session events, preventing silent drops on reconnect.

#### SSE Lifecycle Contract

All three crossreview models independently flagged SSE behavior as critically underspecified. This contract is binding for Phase 0/1 implementation.

**Event format:**
```
id: <monotonic-sequence-number>
event: job_started|job_completed|job_failed|job_state_changed|heartbeat
data: {"slug":"health-check","runId":"abc123","result":"success","timestamp":"2026-03-20T...","error":null}
```

**Event IDs:** Every event includes an `id:` field (monotonic integer). The browser's `EventSource` automatically sends `Last-Event-ID` on reconnect. The server replays missed events from an in-memory ring buffer (last 100 events, ~10 min at normal load).

**Heartbeat:** Server sends `event: heartbeat` with `data: {"ts":<epoch>}` every 15 seconds. Client uses this to detect stale connections — if no heartbeat received for 45 seconds, close and reconnect.

**Reconnect strategy:**
1. Browser `EventSource` auto-reconnects on disconnect (built-in)
2. On reconnect, `Last-Event-ID` is sent → server replays missed events
3. If `Last-Event-ID` is too old (outside ring buffer), server sends `event: resync` with full current state → client does a full refresh of job data via `GET /jobs`
4. Exponential backoff: 1s, 2s, 4s, 8s, max 30s (configured via `retry:` SSE field)

**Auth expiry handling:**
- SSE endpoint returns `401` if bearer token is invalid/expired
- On `401`, client shows a PIN unlock overlay (same as existing dashboard auth flow)
- After re-auth, client opens a new `EventSource` connection

**Tab suspension:**
- When `document.hidden` becomes true (tab backgrounded), close the SSE connection to free browser connection slots
- When `document.hidden` becomes false, reconnect with `Last-Event-ID` for seamless resync
- This prevents the browser's HTTP/1.1 connection limit (~6 per domain) from being exhausted by backgrounded tabs

**Browser connection limits:** Under HTTP/1.1, browsers limit concurrent connections to ~6 per domain. The SSE connection counts as one. Opening multiple dashboard tabs will exhaust this limit. Mitigation: close SSE on tab background (above), and document that only one dashboard tab should be active at a time. HTTP/2 multiplexing eliminates this issue — the server should enable HTTP/2 when running behind Cloudflare tunnel (which it already does).

### A4. Auth Token Lifecycle

The dashboard uses PIN-based auth that returns a bearer token. The crossreview identified that token lifecycle is unspecified.

**Token storage:** `sessionStorage` (not `localStorage`). Token is cleared when the tab closes. This prevents token persistence across browser sessions.

**Token TTL:** Tokens do not expire server-side (the server generates them from config and they're static). However, if the server restarts, config may regenerate the token. The dashboard should handle `401` responses gracefully.

**401 handling across all channels:**
- API fetch: Show PIN unlock overlay, re-auth, retry the failed request
- SSE: Close `EventSource`, show PIN overlay, reconnect after re-auth
- Polling: Same as API fetch — show overlay, re-auth, resume polling

**UI behavior:** The PIN overlay is a full-screen modal (existing pattern) that blocks all interaction until auth succeeds. After re-auth, the dashboard resumes from its current state (no page reload needed).

### A5. Attention Queue: Header Badge + Slide-Out Panel

**Decision:** Attention queue is a persistent header element, not a tab.

- Bell icon in header with red badge showing open item count
- Clicking opens a slide-out panel from the right (300px wide, overlay on mobile)
- When open items exist at login, auto-open the panel once
- Panel has Acknowledge and Dismiss actions per item
- Panel polls `/attention` every 60 seconds (attention items are low-frequency)

### A6. Job History Retention Policy

**Decision:** Cap at 500 runs per job, with a nightly trim job.

- Server enforces max 500 entries per slug in the JSONL ledger
- New trim job: `ledger-trim` runs daily at 3am, removes entries beyond the cap
- Secondary bound: 90-day time-based cutoff (entries older than 90 days always trimmed)
- `GET /jobs/history` supports `?slug=<slug>` filter and `?limit=N` with server-side pagination (`?offset=N`)
- This must be implemented before the Phase 2 Reports view is built

### A7. "Run Now" Response Contract

**Decision:** `POST /jobs/:slug/run` returns `202 Accepted` with a run ID.

```json
{ "status": "accepted", "runId": "health-check-abc123", "message": "Job queued for execution" }
```

**Frontend feedback loop (SSE-primary, poll-as-fallback):**
1. Button shows spinner + "Running..." + elapsed timer
2. **Primary path:** Listen for SSE `job_completed` or `job_failed` event matching `runId`
3. **Fallback path:** If `EventSource.readyState !== OPEN` (SSE disconnected), fall back to polling `GET /jobs/history?slug=<slug>&limit=1` every 2 seconds. Stop polling immediately when SSE reconnects.
4. When the result arrives (via SSE or poll), show the result and stop polling if active
5. Timeout at 120 seconds — show "Job still running, check back later"
6. On completion, auto-refresh job state card and history table

**Race condition prevention:** The SSE event and poll response may arrive for the same run. The UI deduplicates by `runId` — if the result is already displayed, subsequent arrivals are ignored. No DOM flicker.

---

## Design

### Phase 0: Server Prerequisites

Before any frontend work, implement these server-side changes:

1. Split `/health` → `/ping` (public) + `/health` (auth-gated)
2. Add `PATCH` to CORS allowed methods
3. Add HTTP security headers to dashboard responses
4. Add `POST /jobs/:slug/run` with rate limiting, slug validation, 409/429 responses
5. Add `PATCH /jobs/:slug` with `{ enabled }` allow-list only
6. Add `?slug=` and `?offset=` params to `GET /jobs/history`
7. Add `PATCH /attention/:id` and `DELETE /attention/:id`
8. Add `GET /jobs/events` SSE endpoint
9. Add dashboard action audit logging to security.jsonl

---

### Phase 1: Jobs Tab + Vital Signs Strip

#### 1A. Vital Signs Strip (Header Component)

A persistent status strip in the header, visible on **every tab**. Provides at-a-glance awareness of system health without switching tabs.

**Location:** Inside `.header`, after the tab bar, before the status badge.

**Layout:** Horizontal strip of compact indicators, separated by subtle dividers.

```
[● Healthy 3h 34m] | [Sessions 3/3 ⚠] | [Memory 39% ▪▪▪▪░░░░░░] | [Disk 97% ▪▪▪▪▪▪▪▪▪░ ⚠] | [Jobs 1 failing]
```

**Indicators:**

| Indicator | Data Source | Normal | Warning | Critical |
|-----------|-----------|--------|---------|----------|
| Server Status | `GET /health → status` | Green dot + "Healthy" + uptime | Orange "Degraded" | Red "Down" |
| Sessions | `GET /health → sessions` | `{current}/{max}` | Orange when at max | Red when at max + jobs failing |
| Memory Pressure | `GET /health → memoryPressure` | Green bar + percent | Orange at 60%+ | Red at 75%+ |
| Disk | `GET /health → systemMemory` or `GET /monitoring/memory` | Green bar + percent | Orange at 80%+ | Red at 90%+ |
| Failing Jobs | `GET /health → jobs.failing` | Hidden when 0 | Orange count badge | Red if critical-priority jobs failing |

**Behavior:**
- Polls `GET /health` (auth-gated) every 30 seconds (matches server's own health check interval)
- Warning/critical states use orange/red colors from existing CSS vars (`--orange`, `--red`)
- Clicking indicators navigates to the relevant context: "Jobs: 1 failing" → Jobs tab, "Sessions 3/3" → Sessions tab. Memory and Disk indicators link to Jobs tab (no dedicated Health tab until Phase 3)
- Strip collapses to icons-only on mobile (<768px)
- **Accessibility:** Status indicators must include shape/icon differentiation in addition to color (checkmark for healthy, warning triangle for warning, X for critical) to support color-blind users (~8% of male population)

**Design Constraints:**
- Must not increase header height by more than ~8px on desktop
- Font size: 11px (matches existing `.session-meta` sizing)
- Use existing color variables — no new palette

#### 1B. Jobs Tab

A new tab added to the tab bar after Drop Zone. Registered in `TAB_REGISTRY` (see Architecture Decision A1).

The tab count badge shows total enabled jobs. When any jobs are failing, the count badge turns red and shows failing count instead (e.g., red "1" instead of "23").

**Layout:** Two-panel, matching the existing Sessions tab pattern:
- **Left panel (sidebar):** Job list with status indicators
- **Right panel (main):** Job detail view + run history

##### Left Panel: Job List

Each job is a row showing:
```
● health-check                    ⚠ 8 failures
  Every 5 min · haiku · critical
  Last: spawn-error · 2m ago
  Next: in 3m
```

**Fields per job item:**
- Status dot: green (healthy), orange (1-2 failures), red (3+ failures), gray (disabled), blue (running now)
- Job name (slug, human-readable)
- Schedule in human-readable form (e.g., "Every 5 min", "Every 4 hours", "Daily at 9am", "Mondays at 8am")
- Model badge (haiku/sonnet/opus — reuse existing `.model-badge` classes)
- Priority badge (critical = red outline, high = orange, medium = default, low = dim)
- Last result + relative time
- Next scheduled run (relative time)
- Consecutive failure count (when > 0)

**Sorting:** By default, sort by health status (failing first), then by priority, then alphabetically. Provide a dropdown to sort by: Status, Priority, Name, Next Run, Last Run.

**Filtering:** Tag-based filter chips at top: `All` | `Coherence` | `Default` | `Failing` | `Disabled`

##### Right Panel: Job Detail + History

When a job is selected from the list:

**Header Section:**
```
health-check                              [Run Now] [Enable/Disable]
Monitor server health, session status, and system resources.
Schedule: */5 * * * * (Every 5 minutes)
Model: haiku | Priority: critical | Tags: coherence, default
```

**Current State Card:**
```
┌─────────────────────────────────────────┐
│ Status: ⚠ Failing (8 consecutive)       │
│ Last Run: 2026-03-20 18:30 (5m ago)     │
│ Last Result: spawn-error                 │
│ Error: Max sessions (3) reached.        │
│         Running: session-a, session-b    │
│ Next Run: 2026-03-20 18:35 (in 2m)     │
└─────────────────────────────────────────┘
```

**Run History Table:**

A scrollable table of recent runs (fetched from `GET /jobs/history?slug=<slug>&limit=50`):

| Time | Result | Duration | Error |
|------|--------|----------|-------|
| 18:30 | spawn-error | 0s | Max sessions (3) reached |
| 18:25 | spawn-error | 0s | Max sessions (3) reached |
| 17:45 | success | 11s | — |
| 17:40 | success | 11s | — |
| 17:25 | timeout | 75s | — |

**Result badges:** `success` = green, `failure` = red, `spawn-error` = orange, `timeout` = yellow, `skipped` = gray, `pending` = blue pulse

**Run History Chart (stretch goal):**

A compact sparkline/heatmap showing the last 50 runs as colored blocks:
```
▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▫▪▪▪▪▪▪▪▪▪▫▫▫▫▫▫▫▫▫▫▪▪
green = success, red = failure, orange = spawn-error, yellow = timeout
```

This gives an instant visual read on job stability over time.

##### "Run Now" Button

Triggers an immediate job run via `POST /jobs/:slug/run` (see Phase 0: Server Prerequisites).

**Behavior:**
- Button disabled while job is running (status = pending/running)
- Shows spinner + "Running..." + elapsed timer on click
- Polls `GET /jobs/history?slug=<slug>&limit=1` every 2 seconds to detect completion (matching by `runId` from the 202 response)
- Timeout at 120 seconds — shows "Job still running, check back later"
- On completion, auto-refreshes the history table and state card
- Handles `409 Conflict` (already running) and `429 Too Many Requests` (rate limit) with user-friendly messages

##### Enable/Disable Toggle

Calls `PATCH /jobs/:slug` with `{ enabled: true/false }`. Server enforces a strict allow-list — only the `enabled` field is accepted (see Security Requirement S3).

**Behavior:**
- Toggle switch UI (not a button)
- Disabled jobs are visually dimmed in the job list
- Confirmation prompt when disabling a critical-priority or high-priority job ("This will stop health-check from running. Are you sure?")
- Action logged to security.jsonl via the dashboard action audit log (S6)

##### Empty State

When no jobs exist (shouldn't happen, but for completeness):
```
No jobs configured.
Jobs run automatically on schedules to keep the agent healthy and informed.
```

##### Data Fetching Strategy

- Initial load: `GET /jobs` (includes state for all jobs)
- **Real-time updates:** Subscribe to `GET /jobs/events` (SSE) when Jobs tab is active (see Architecture Decision A3). Events update job state in-place without full poll.
- **Fallback polling:** If SSE connection fails, fall back to 30-second polling of `GET /jobs`
- Job history: Fetched on-demand when a job is selected (lazy load) via `GET /jobs/history?slug=<slug>&limit=50`
- SSE subscription closed when user switches away from Jobs tab (no wasted connections)

---

### Phase 2: Job Reports + Attention Queue

#### 2A. Reports Sub-View (within Jobs tab)

A "Reports" toggle within the Jobs tab that shows job output/reports chronologically.

**Data source:** `GET /jobs/history` enriched with session output where available. Job runs that spawned sessions can have their output retrieved via `GET /sessions/:name/output`.

**Layout:**
- Reverse-chronological feed of job completions
- Each entry shows: job name, timestamp, result, duration, and expandable output
- Filter by job slug, result type, or date range
- Handoff notes (from the handoff-notes system) displayed inline between runs of the same job

**Report Card:**
```
┌─────────────────────────────────────────┐
│ 🩺 health-check · 17:45 · success · 11s │
│                                          │
│ Server healthy. Uptime 3h 10m.          │
│ Disk: 97% (⚠ flagged). Memory: 38%.    │
│ Sessions: 2/3. No failing jobs.         │
│                                          │
│ 📎 Handoff note → next run:             │
│ "Disk at 97%, monitor for further rise"  │
└─────────────────────────────────────────┘
```

#### 2B. Attention Queue Panel (Header Badge + Slide-Out)

A persistent header element (not a tab) — see Architecture Decision A4. Attention items are urgent, rare, and actionable — they need always-visible presence, not a tab you'd have to switch to.

**Header Badge:**
- Bell icon in header with red badge showing count of open items (hidden when 0)
- Clicking opens a 300px slide-out panel from the right (overlay on mobile)
- When open items exist at login, auto-open the panel once as a prompt

**Panel Content:**
```
📌 Attention Queue (1 open)

┌─────────────────────────────────────────┐
│ 🔴 HIGH · ci-release-token-missing      │
│ RELEASE_TOKEN secret missing — publish   │
│ workflow broken.                         │
│                                          │
│ v0.23.12 published to npm but version   │
│ bump commit rejected by branch           │
│ protection. Need: create PAT, set       │
│ secret, clean up orphaned tag.          │
│                                          │
│ Topic: 1354 · Opened: 2026-03-19        │
│                                          │
│ [Acknowledge] [Dismiss]                  │
└─────────────────────────────────────────┘
```

**Actions:**
- **Acknowledge:** Marks as seen but keeps open (`PATCH /attention/:id { status: "ACKNOWLEDGED" }`)
- **Dismiss:** Closes the item (`DELETE /attention/:id`)
- Priority sorting: Critical → High → Medium → Low

---

### Phase 3: System Insights Tabs

#### 3A. Health Tab (expanded from vital signs)

A dedicated tab for deeper system health inspection.

**Sections:**

1. **System Review** — Last diagnostic results
   - Probes passed/failed/skipped (13/16 passed currently)
   - Per-probe detail (expandable): what each probe checks, its last result
   - "Run Diagnosis" button to trigger a fresh system review

2. **Resource Gauges**
   - Memory pressure: gauge visualization with threshold markers
   - Disk space: segmented bar showing usage by volume
   - Process memory: RSS, heap used/total for the instar server
   - Claude processes: tracked vs orphan vs external, total memory

3. **Degradation History**
   - Timeline of health state transitions (healthy → degraded → healthy)
   - What caused each degradation

4. **Session Economics**
   - Current sessions vs max
   - Session spawn rate over time
   - Blocked job runs due to session saturation (this is a real problem — visible in today's data)

#### 3B. Evolution Tab

Tracks the agent's self-improvement systems.

**Sections:**

1. **Evolution Proposals**
   - List of proposals with status (pending/approved/implemented/rejected)
   - Detail view: what change was proposed, why, outcome
   - Approve/reject actions for pending proposals (requires PIN re-entry — see Security Requirement S7)
   - All approvals/rejections logged to `.instar/security.jsonl`

2. **Playbook Items**
   - Scored context items from `instar playbook status`
   - Triggers, scores, lifecycle state
   - Decay visualization (items losing relevance over time)

3. **Memory & Learning**
   - MEMORY.md rendered as browsable sections
   - Last memory hygiene run + stats
   - Topic memory overview: message counts, topic list, search

#### 3C. Autonomy & Trust Tab

**Sections:**

1. **Autonomy Profile**
   - Current profile name + description (e.g., "collaborative — I propose, you approve")
   - Evolution mode, safety mode
   - Change profile buttons (with confirmation)

2. **Trust Dashboard**
   - Global trust: maturity %, floor level
   - Per-service trust cards (when services are configured)
   - Trust progression timeline

3. **Operation Log**
   - Recent operations evaluated by the gate
   - Decision for each: allowed, blocked, plan-required (display shows decision + category only — full parameters redacted to prevent gate rulebook exposure, see Security Requirement S8)
   - Filterable by service, decision, time range

---

## Implementation Plan

### What Needs to Be Built

**Phase 0 — Server prerequisites (must ship before any frontend):**

| Endpoint / Change | Method | Purpose | Security | Complexity |
|----------|--------|---------|----------|------------|
| `/ping` | GET | Public health ping (replaces unauthenticated `/health`) | Public — returns `{"status":"ok"}` only | Trivial |
| `/health` | GET | Auth-gate existing endpoint | Require bearer token | Trivial |
| `/jobs/:slug/run` | POST | Trigger immediate job run | Rate limit: 1/interval, 5 concurrent max. Slug validated `/^[a-z0-9-]+$/`. Returns `202 + runId`. Logs to security.jsonl | Medium |
| `/jobs/:slug` | PATCH | Enable/disable job | Allow-list: `{ enabled: boolean }` only. 400 on other fields. Logs to security.jsonl | Low |
| `/jobs/history` | GET | Add `?slug=`, `?offset=`, `?limit=` params | Auth required. Server-side pagination | Low |
| `/jobs/events` | GET | SSE stream for job state changes | Auth required. Events: started, completed, failed, state_changed | Medium |
| `/attention/:id` | PATCH | Acknowledge attention item | Allow-list: `{ status: "ACKNOWLEDGED" }` only | Low |
| `/attention/:id` | DELETE | Dismiss attention item (soft-delete) | Logs to security.jsonl | Low |
| CORS middleware | — | Add `PATCH` to allowed methods | — | Trivial |
| Security headers | — | X-Frame-Options, X-Content-Type-Options, CSP, Referrer-Policy | — | Low |

**Phase 1 — Frontend (APIs exist after Phase 0):**
- TAB_REGISTRY refactor of `switchTab()` (Architecture Decision A1)
- `wsOn(type, fn)` pub-sub refactor of WebSocket dispatch
- Vital signs strip (polls auth-gated `GET /health`)
- Job list + detail view (uses `/jobs`, `/jobs/history?slug=`, `/jobs/events` SSE)
- Run Now + Enable/Disable controls

**Phase 2 — Frontend + server:**
- Retention policy implementation: 500 runs/job cap, nightly trim job, 90-day cutoff (Architecture Decision A5)
- Reports sub-view within Jobs tab
- Attention queue header badge + slide-out panel
- Job output persistence (storage design TBD — see Gaps section)

**Phase 3 — Frontend + server:**
- System dropdown group (Health, Evolution, Autonomy tabs)
- PIN re-entry auth tier for evolution approve/reject
- Operation log sanitization
- Health deep-dive, Evolution, Autonomy tab content

### File Changes

**Server (`/Users/justin/Documents/Projects/instar/src/server/`):**
- `routes.ts` — New endpoints: `/ping`, `/jobs/:slug/run`, `/jobs/:slug` PATCH, `/jobs/events` SSE, `/attention/:id` PATCH/DELETE. Auth-gate `/health`. Add slug validation, rate limiting, field allow-lists.
- `AgentServer.ts` — CORS middleware update (add PATCH), security headers middleware.
- New file or section in routes: SSE event stream for job events.
- Estimated: ~300 lines of server code.

**Dashboard (`/Users/justin/Documents/Projects/instar/dashboard/index.html`):**
- CSS: ~350 lines (job list, detail, gauges, vital signs, attention panel, system dropdown)
- HTML: ~150 lines (new tab content divs, vital signs strip, attention slide-out)
- JS: ~600 lines (TAB_REGISTRY refactor, wsOn pub-sub, SSE subscription, data fetching, rendering, cron converter, interactions)
- Total estimated growth: ~1,100 lines (~11% of current 102KB file)

### Build Order

**Phase 0 (server — do first):**
1. Split `/health` → `/ping` + auth-gated `/health`
2. CORS + security headers
3. `POST /jobs/:slug/run` with rate limits + audit logging
4. `PATCH /jobs/:slug` with field allow-list
5. `GET /jobs/history` pagination + slug filter
6. `GET /jobs/events` SSE endpoint
7. `PATCH /attention/:id` + `DELETE /attention/:id`

**Phase 1 (frontend):**
8. **TAB_REGISTRY refactor** — Data-driven tab system replacing imperative `switchTab()`.
9. **WebSocket pub-sub refactor** — `wsOn(type, fn)` pattern replacing `onmessage` assignment.
10. **Vital signs strip** — Highest value-per-line-of-code. Immediately makes health visible.
11. **Jobs tab: list view** — See all 23 jobs with status at a glance.
12. **Jobs tab: detail + history** — Click into a job, see its run history via SSE + lazy-loaded history.
13. **Jobs tab: run-now + enable/disable** — Interactive controls with feedback loop.

**Phase 2 (blocked by retention policy decision):**
14. **Retention policy** — Server-side 500-run cap + nightly trim job.
15. **Reports sub-view** — Job output feed within Jobs tab.
16. **Attention queue** — Header badge + slide-out panel.

**Phase 3 (blocked by elevated auth implementation):**
17. **PIN re-entry auth tier** for evolution/autonomy actions.
18. **Operation log sanitization** — Redact full parameters.
19. **System dropdown + Phase 3 tabs** — Health, Evolution, Autonomy.

### Cron-to-Human Schedule Conversion

The dashboard must convert cron expressions to human-readable strings. A lightweight converter is needed (no external dependency — inline JS function).

| Cron | Human |
|------|-------|
| `*/5 * * * *` | Every 5 minutes |
| `0 */4 * * *` | Every 4 hours |
| `0 9 * * *` | Daily at 9:00 AM |
| `0 */12 * * *` | Every 12 hours |
| `0 8 * * 1` | Mondays at 8:00 AM |
| `0 * * * *` | Every hour |
| `*/30 * * * *` | Every 30 minutes |

**Error handling (Grok catch):** LLM-modified `jobs.json` may contain invalid cron expressions. The converter must:
- Wrap parsing in try/catch
- On failure, display the raw cron string with an orange "Invalid schedule" badge
- Never crash the tab renderer — malformed cron in one job must not prevent other jobs from displaying
- Log malformed cron to console for debugging

---

## UX Principles

1. **Data density over decoration.** This is an operational dashboard — pack information in, minimize whitespace. Take cues from Grafana, not marketing sites.
2. **Problems float to the top.** Failing jobs sort first. Warning indicators use color. The vital signs strip means you never have to hunt for trouble.
3. **Lazy loading.** Job history loads on click, not on tab open. Reports load on scroll. Keep initial render fast.
4. **Consistent with existing design.** Same dark theme, same color variables, same font sizes, same component patterns (badges, cards, lists). The new tabs should feel like they've always been there.
5. **Mobile-aware.** Jobs list goes full-width on mobile. Detail view replaces list (back button pattern, matching Sessions tab). Vital signs strip collapses to icons.
6. **No external dependencies.** The dashboard is currently zero-dependency frontend (CDN libs only for xterm and highlight.js). Keep it that way — no React, no build step, no charting library. Sparklines and gauges are simple enough to do with CSS or canvas.
7. **Graceful error states.** Every data fetch must have defined error UX: offline indicator (gray banner: "Server unreachable — retrying..."), retry button after 3 failed attempts, SSE disconnect banner ("Live updates paused — reconnecting..."), and fallback rendering for missing/null fields (dash `—` not blank, tooltip "Data unavailable"). API 5xx → show last cached data with "Stale data" indicator.
8. **DOM hygiene.** Dashboards left open for hours/days accumulate SSE-driven DOM updates. Cap history tables at 100 rows — when a new row arrives via SSE, drop the oldest. Cap job log entries at 50 per expansion. This prevents memory leaks and UI lag on long-lived tabs.

---

## Resolved Questions (from SpecReview Round 1)

These were originally open questions. All resolved by reviewer consensus.

| # | Question | Decision | See |
|---|----------|----------|-----|
| 1 | Job output persistence | Deferred — metadata sufficient for Phase 1. Full output persistence design needed before Phase 2 Reports view. | Gaps section |
| 2 | Real-time job events | Use SSE (`GET /jobs/events`), not WebSocket extension. | Architecture Decision A3 |
| 3 | Tab overflow | "System" dropdown group for Phase 3 tabs. Tab bar stays at 5 items max. | Architecture Decision A2 |
| 4 | Attention queue: header vs tab | Header badge + slide-out panel. Not a tab. | Architecture Decision A5 |
| 5 | Historical depth | 500 runs per job cap + 90-day cutoff + nightly trim job. | Architecture Decision A6 |
| 6 | CSP + inline JS | `'unsafe-inline'` for Phase 1. Nonce-based CSP is Phase 3 future work. | Security S4 |
| 7 | SSE lifecycle | Full contract defined: event IDs, heartbeat, reconnect, tab suspension, auth handling. | Architecture Decision A3 |
| 8 | Run Now update race | SSE-primary, poll-as-fallback. Dedup by runId. | Architecture Decision A7 |
| 9 | Auth token lifecycle | `sessionStorage`, no server TTL, 401 shows PIN overlay. | Architecture Decision A4 |
| 10 | Health data source | Single canonical endpoint (`GET /health`). Not `/monitoring/memory`. | Appendix A |
| 11 | `/health` → `/ping` migration | Phased 3-week cutover with warning logs. | Security S1 |

---

## Remaining Gaps

Items not yet resolved. Must be addressed before the relevant phase ships.

1. **Job output persistence schema (blocks Phase 2).** The Reports view needs job outputs, but they currently live in ephemeral tmux buffers. Need a concrete storage design: file naming convention for `.instar/ledger/job-outputs/`, size limits per output, cleanup policy, and how run IDs map to output files.

2. **"Run Now" → session correlation.** The `POST /jobs/:slug/run` returns a `runId`. How does this map to the tmux session name? Can we retrieve output for a specific run via `GET /sessions/:name/output`? The session naming convention needs to be documented.

3. **Multi-agent dashboard federation.** The job history ledger already includes `machineId`. If multiple agents share a dashboard in the future, the current API responses would need to distinguish between agents. Not blocking for Phase 1 (single-agent), but worth tracking.

4. **Accessibility.** Only color-blind support was identified (see vital signs strip). Full accessibility audit needed: keyboard navigation for all new components, ARIA labels on interactive elements, screen reader compatibility for job status indicators and the attention queue panel.

5. **Cron converter coverage.** The inline cron-to-human converter needs to handle all patterns present in the current 23 jobs. Survey of `.instar/jobs.json` should inform the converter's test cases. Known patterns: `*/N * * * *`, `0 */N * * *`, `0 N * * *`, `0 N * * D`.

6. **Handoff notes storage model.** The Reports view shows handoff notes inline between job runs. Where are these stored? Do they need a separate retention policy? Privacy reviewer flagged they may contain sensitive content — rendering must use `textContent` not `innerHTML`.

---

## Phase Gates

Hard prerequisites that must be verified before proceeding to the next phase.

**Phase 0 → Phase 1:**
- [ ] `/ping` returns `{"status":"ok"}` without auth; `/health` returns 401 without auth
- [ ] `POST /jobs/:slug/run` returns 429 on rate limit, 409 if already running
- [ ] `PATCH /jobs/:slug` returns 400 if any field besides `enabled` is sent
- [ ] All mutation endpoints log to `.instar/security.jsonl`
- [ ] CORS preflight succeeds for PATCH requests
- [ ] Security headers present on all dashboard responses

**Phase 1 → Phase 2:**
- [ ] Retention policy implemented: 500-run cap per job + nightly trim job
- [ ] Job output persistence schema designed and documented
- [ ] `GET /jobs/history?slug=X&limit=N&offset=M` works with server-side pagination

**Phase 2 → Phase 3:**
- [ ] PIN re-entry auth tier implemented for elevated actions
- [ ] Operation log sanitization implemented (decision + category only)
- [ ] HTTP security headers include strict CSP

---

## Success Criteria

- [ ] A user can open the dashboard and within 3 seconds know: Is the server healthy? Are jobs running? Is anything failing?
- [ ] A user can see all 23 jobs, their schedules, and their current health status on one screen
- [ ] A user can click into any job and see its last 50 runs with results, durations, and errors
- [ ] Failing jobs are visually prominent — red indicators, sorted to top, visible in the vital signs strip
- [ ] Status indicators use shape + color (not color alone) for accessibility
- [ ] The vital signs strip persists across all tabs and updates every 30 seconds
- [ ] Real-time job events arrive via SSE within 2 seconds of completion
- [ ] Attention queue items are visible via header badge without switching tabs
- [ ] All new UI is consistent with existing dashboard design language
- [ ] Mobile-responsive: usable on phone screens
- [ ] No new external dependencies
- [ ] All dashboard-initiated mutations are audit-logged
- [ ] No `innerHTML` with untrusted content — all dynamic rendering uses `textContent` or `escapeHtml()`
- [ ] SSE reconnect works seamlessly — tab suspension, heartbeat detection, `Last-Event-ID` resync
- [ ] All API error states have defined UX — offline banner, retry button, stale data indicator
- [ ] History tables capped at 100 rows (DOM hygiene)
- [ ] Cron converter handles malformed input without crashing
- [ ] CSP header present and doesn't break inline JS

---

## Appendix A: API Response Schemas

Exact JSON shapes for all endpoints consumed by the dashboard. Prevents implementation drift.

### `GET /ping` (public, no auth)

```json
{ "status": "ok" }
```

### `GET /health` (auth required)

```json
{
  "status": "ok" | "degraded",
  "uptime": "3h 34m",
  "uptimeMs": 12840000,
  "sessions": {
    "current": 2,
    "max": 3,
    "running": ["echo-lifeline", "echo-topic-foo"]
  },
  "memory": {
    "percent": 38.7,
    "state": "low" | "moderate" | "high" | "critical",
    "freeGB": 5.2,
    "totalGB": 8.0
  },
  "disk": {
    "percent": 81,
    "freeGB": 36.2,
    "totalGB": 186.0,
    "path": "/System/Volumes/Data"
  },
  "jobs": {
    "total": 23,
    "enabled": 20,
    "failing": 1,
    "failingSlugs": ["health-check"]
  },
  "degradations": []
}
```

**Canonical data source for vital signs:** ALL vital signs data comes from this single endpoint. `GET /monitoring/memory` is NOT used by the dashboard — it's a more detailed endpoint for programmatic consumers. This eliminates the field name inconsistency flagged by GPT and Grok.

### `GET /jobs` (auth required)

```json
{
  "jobs": [
    {
      "slug": "health-check",
      "description": "Check server health and report issues",
      "schedule": "*/5 * * * *",
      "enabled": true,
      "model": "haiku",
      "priority": "critical",
      "tags": ["monitoring"],
      "state": {
        "lastRun": "2026-03-20T12:05:00.000Z",
        "lastResult": "spawn-error",
        "lastError": "Max sessions reached (3/3)",
        "lastDurationMs": 1200,
        "consecutiveFailures": 8,
        "nextScheduled": "2026-03-20T12:10:00.000Z",
        "isRunning": false,
        "currentRunId": null
      }
    }
  ]
}
```

### `GET /jobs/history?slug=health-check&limit=50&offset=0` (auth required)

```json
{
  "runs": [
    {
      "runId": "health-check-mmyriu66",
      "slug": "health-check",
      "trigger": "scheduled" | "manual",
      "startedAt": "2026-03-20T12:05:00.000Z",
      "endedAt": "2026-03-20T12:05:01.200Z",
      "durationMs": 1200,
      "result": "success" | "error" | "timeout" | "spawn-error",
      "error": "Max sessions reached (3/3)",
      "model": "haiku",
      "sessionName": "echo-job-health-check-mmyriu66"
    }
  ],
  "total": 487,
  "limit": 50,
  "offset": 0
}
```

### `GET /attention` (auth required)

```json
{
  "items": [
    {
      "id": "att-abc123",
      "priority": "high" | "medium" | "low",
      "status": "OPEN" | "ACKNOWLEDGED" | "DISMISSED",
      "summary": "Disk usage at 97% on /System/Volumes/Data",
      "detail": "...",
      "createdAt": "2026-03-20T10:00:00.000Z",
      "acknowledgedAt": null,
      "source": "health-check"
    }
  ]
}
```

**State machine:** `OPEN` → `ACKNOWLEDGED` (user saw it) → `DISMISSED` (user cleared it). Badge count = items where `status === "OPEN"`. Panel shows OPEN and ACKNOWLEDGED; DISMISSED items are hidden (available via `?status=DISMISSED` for audit).

### `GET /jobs/events` (SSE, auth required)

See Architecture Decision A3 for full SSE lifecycle contract.

```
id: 1
event: job_started
data: {"slug":"health-check","runId":"health-check-mmyriu66","timestamp":"2026-03-20T12:05:00.000Z"}

id: 2
event: job_completed
data: {"slug":"health-check","runId":"health-check-mmyriu66","result":"success","durationMs":1200,"timestamp":"2026-03-20T12:05:01.200Z","error":null}

id: 3
event: job_failed
data: {"slug":"health-check","runId":"health-check-mmyriu66","result":"spawn-error","durationMs":0,"timestamp":"2026-03-20T12:05:00.500Z","error":"Max sessions reached (3/3)"}

id: 4
event: heartbeat
data: {"ts":1774041600}
```

### `POST /jobs/:slug/run` (auth required)

**Success (202):**
```json
{ "status": "accepted", "runId": "health-check-abc123", "message": "Job queued for execution" }
```

**Errors:**
- `400`: `{ "error": "Invalid job slug" }`
- `404`: `{ "error": "Job not found" }`
- `409`: `{ "error": "Job is already running", "currentRunId": "health-check-xyz789" }`
- `429`: `{ "error": "Rate limit exceeded — max 1 manual trigger per 5m", "retryAfterMs": 180000 }`

### `PATCH /jobs/:slug` (auth required)

**Request:** `{ "enabled": false }` (only field accepted)

**Success (200):** `{ "slug": "health-check", "enabled": false, "updated": true }`

**Errors:**
- `400`: `{ "error": "Only 'enabled' field is accepted" }` (if other fields sent)
- `404`: `{ "error": "Job not found" }`

### `PATCH /attention/:id` (auth required)

**Request:** `{ "status": "ACKNOWLEDGED" }`

**Success (200):** `{ "id": "att-abc123", "status": "ACKNOWLEDGED", "updated": true }`

### `DELETE /attention/:id` (auth required)

**Success (200):** `{ "id": "att-abc123", "deleted": true }`

**Error:** `404`: `{ "error": "Attention item not found" }`
