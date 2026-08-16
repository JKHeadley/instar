# Security Review: Dashboard Observability — Jobs, Health, and Agent Insights

**Spec:** `/Users/justin/.instar/agents/echo/specs/dashboard-observability.md`
**Review ID:** 20260320-113858
**Round:** 1
**Reviewer Role:** Security Specialist
**Date:** 2026-03-20

---

## Approval Status: CONDITIONAL

The spec describes a well-scoped observability expansion to an existing dashboard. The existing security infrastructure (timing-safe PIN comparison, bearer token auth, IP-based lockout, CORS restriction to localhost) is solid for a local management tool. The new features introduce several issues — primarily around **token exposure in WebSocket URLs**, **missing rate limiting on new mutation endpoints**, **operation log data sensitivity**, and **XSS surface area from error/output rendering**. None are blockers to a pre-code spec review, but all must be addressed in implementation.

---

## Research Findings

### 1. WebSocket Token-in-URL is a Known Attack Vector
OWASP REST Security Cheat Sheet explicitly states: "Passwords, security tokens, and API keys should not appear in the URL, as this can be captured in web server logs." The existing dashboard already does this (`/ws?token=<token>`) and the spec proposes reusing this connection for job events. This is an accepted tradeoff for browser WebSockets (which cannot set custom headers), but it means any server-access log captures the full auth token in plaintext. Since this server may be exposed via Cloudflare tunnel, this is not purely theoretical.

### 2. Grafana-Class Privilege Bypass Pattern
Grafana's security docs warn that viewers with UI-only restrictions can bypass them by directly querying the API. Instar's current model does not have role differentiation — the dashboard bearer token grants full API access. Adding mutation endpoints (`POST /jobs/:slug/run`, `PATCH /jobs/:slug`) extends the blast radius: anyone with the dashboard token (obtained via PIN auth) can now trigger arbitrary job execution and disable jobs. This is the correct design for a single-user agent, but the spec should acknowledge this explicitly.

### 3. Operation Log Contains Sensitive Decision Context (OWASP A02 Sensitive Data Exposure)
The spec proposes surfacing `GET /operations/log` — "operation gate decisions (allow/block/plan)". Operation logs routinely contain rejected action descriptions (e.g., "blocked: attempted to write to /etc/hosts"), tool invocation details, and service names. Rendering this in a dashboard that may be shared via tunnel URL creates a secondary exposure path beyond the authenticated API.

### 4. CSP for Inline-Script Monolithic Dashboards
The dashboard is a single `index.html` with inline scripts. OWASP CSP guidelines warn that nonce-based CSP is the correct approach here; without it, any injected content that escapes `escapeHtml()` can execute. The spec adds new rendering paths (job error messages, handoff notes, session output excerpts) each of which is a potential XSS vector.

### 5. CSRF Posture for New Mutation Endpoints
OWASP CSRF Cheat Sheet confirms that bearer tokens transmitted via `Authorization` headers provide inherent CSRF protection because browsers cannot automatically attach custom headers cross-origin. The new `POST /jobs/:slug/run` and `PATCH /jobs/:slug` endpoints will use the existing bearer token scheme, so CSRF is not a concern for API consumers. However, if any mutation is ever triggered via a plain form (no custom header), the protection disappears.

---

## Critical Issues

### ISSUE-SEC-01 | Severity: HIGH
**Auth token exposed in WebSocket URL (existing + extended by spec)**

**Spec section:** Phase 1 (Data Fetching Strategy) — "Use the existing WebSocket connection to receive real-time job status updates if available."

**Finding:** The dashboard connects via `ws://...?token=<full_auth_token>`. The spec proposes routing job status events through this same connection. The token appears in server access logs, browser history, and any network logging middleware. If the server is tunnel-exposed, this extends to Cloudflare access logs outside the operator's control.

**Fix:** Token-in-URL is unavoidable for browser WebSocket upgrades (browsers cannot set `Authorization` headers on WebSocket handshakes). The mitigation is: (a) ensure the server never logs the raw WS upgrade URL, or redacts query parameters from access logs; (b) document that tunneled access exposes the token to Cloudflare logs; (c) consider short-lived WS session tokens exchanged via the already-authenticated REST API (`POST /ws/token` → one-time token, 60s TTL) so the long-lived auth token never appears in a URL.

---

### ISSUE-SEC-02 | Severity: HIGH
**New mutation endpoints lack dedicated rate limiting**

**Spec section:** Implementation Plan — `POST /jobs/:slug/run`, `PATCH /jobs/:slug`

**Finding:** The existing middleware.ts `rateLimiter` is applied at specific routes (spawn: 10/min, feedback: 10/min, paste: 10/min). The spec does not specify rate limits for the new job mutation endpoints. An attacker with a valid token could:
- Spam `POST /jobs/:slug/run` to trigger hundreds of Claude sessions, exhausting API quota and system resources.
- Rapidly toggle `PATCH /jobs/:slug` enabled/disabled to disrupt scheduled operations.

The spec notes the "Run Now" button should be disabled while a job is running, but this is a UI-only control. The server endpoint has no such protection.

**Fix:** Apply a per-slug rate limiter on `POST /jobs/:slug/run` (e.g., max 1 run per job per 60 seconds, with a global cap of 5 concurrent manual triggers). Apply a conservative rate limit on `PATCH /jobs/:slug` (e.g., 10 modifications per 5 minutes). Add server-side guard: if a job is already running/pending, reject the trigger with `409 Conflict`.

---

### ISSUE-SEC-03 | Severity: HIGH
**Job error messages and handoff notes rendered as HTML without explicit sanitization audit**

**Spec section:** Phase 2A (Report Card), Phase 1B (Current State Card — "Error: Max sessions (3) reached. Running: session-a, session-b")

**Finding:** Job error strings originate from Claude session output, system calls, and cron execution — all external inputs. Handoff notes are LLM-generated. The spec renders these in the dashboard HTML. The existing `escapeHtml()` function uses the browser's own DOM parser (creates a `div`, sets `textContent`, reads `innerHTML`) which is correct, but the spec does not explicitly require this function to be used for all new rendering paths. In a 950-line JS addition to an existing 102KB monolith, it is easy to accidentally use `innerHTML =` with unescaped content.

**Fix:** In the implementation: (a) mandate `escapeHtml()` for all user/agent-originating string values before insertion into the DOM; (b) audit every `innerHTML` assignment in the new code at PR time; (c) consider a lint rule or code comment convention (`// SAFE: escapeHtml applied`) marking all innerHTML calls. For handoff notes specifically, since they may contain markdown: if rendered as markdown, use a sanitizing renderer (e.g., DOMPurify before any markdown-to-HTML path).

---

### ISSUE-SEC-04 | Severity: MEDIUM
**Operation log surfaces sensitive blocked-action descriptions**

**Spec section:** Phase 3C (Autonomy & Trust Tab — Operation Log: "Recent operations evaluated by the gate. Decision for each: allowed, blocked, plan-required.")

**Finding:** Operation gate logs contain: the full action that was evaluated, the service it targeted, and the reason it was blocked. If a job attempted to send a message containing a secret and was blocked, the block reason may contain a partial reproduction of that data. Displaying this log in a dashboard accessible via shared tunnel URL, or in a screenshot context, exposes operational intelligence about what the agent has been attempting.

**Fix:** (a) Scrub or truncate action detail strings in the operation log API response before surfacing in the UI — show service + decision + timestamp, but truncate the "action" field to e.g. 100 chars and redact anything matching known-sensitive patterns (URLs with tokens, file paths containing secrets, email addresses). (b) Add a note in the spec that the operation log endpoint response shape should be reviewed before being rendered verbatim.

---

### ISSUE-SEC-05 | Severity: MEDIUM
**`GET /health` is public — vital signs strip leaks system state to unauthenticated requests**

**Spec section:** Phase 1A (Vital Signs Strip) — "Polls `/health` every 30 seconds"

**Finding:** The spec explicitly notes `/health` is unauthenticated ("All endpoints require Authorization except `/health`"). The vital signs strip shows disk at 97%, session counts, job failure counts, and memory pressure. When the server is tunnel-exposed, this data is visible to anyone with the tunnel URL — no PIN required. This is not new (the health endpoint already exists), but the spec doubles down on how much information it exposes: job failure counts, session saturation, memory states. This is an enumeration risk that helps an attacker understand optimal attack timing (e.g., "sessions at 3/3, new jobs will fail — good time to attack").

**Fix:** Consider splitting `/health` into a shallow ping (status: ok/degraded, uptime only — stays public) and a detailed health endpoint (`/health/detail`) that requires auth. The vital signs strip should call the authenticated detailed endpoint after token acquisition. The unauthenticated public endpoint serves external monitoring (uptime checkers) and nothing more.

---

### ISSUE-SEC-06 | Severity: MEDIUM
**`PATCH /jobs/:slug` allow-list not specified — partial update attack surface**

**Spec section:** Implementation Plan — `PATCH /jobs/:slug` with `{ enabled: true/false }`

**Finding:** The spec only describes enabling/disabling jobs, but does not constrain what fields `PATCH /jobs/:slug` will accept. If the implementation naively merges the request body into the job config, an attacker with a valid token could modify job schedules, change the model (from haiku to opus, inflating costs), alter job prompts, or modify priority to suppress critical-job alerting.

**Fix:** The server-side implementation must use an explicit allow-list: only `enabled` (boolean) is patchable via this endpoint. Any other fields in the request body must be rejected with 400. Document this constraint in the spec.

---

## Observations

### OBS-01: PIN falls back to raw token entry (existing behavior, acknowledged)
Spec line: "Try PIN-based unlock first, fall back to direct token auth." The dashboard allows entering the raw bearer token directly if the PIN endpoint returns 404. This means the token itself can be used as authentication input. For a local tool this is acceptable, but it means the token has dual duty as both a high-entropy auth token and a potential fallback credential that a user might share. Not a critical issue, but worth noting in security documentation.

### OBS-02: localStorage token storage (existing)
The auth token is persisted in `localStorage`. This is standard for SPAs but means the token survives across browser sessions and is accessible to any same-origin JavaScript. If a future feature loads untrusted content into the same origin (e.g., rendering user-submitted markdown with script tags), this becomes a token theft vector. The existing `escapeHtml()` approach defends against this, but the dependency chain between "token in localStorage" and "always escape user content" should be explicit.

### OBS-03: Job slug used as URL path parameter — potential path traversal
`GET /jobs/history?slug=<slug>` and `POST /jobs/:slug/run` use slug values as identifiers. If slugs are not validated against a known-safe format (alphanumeric + hyphens), a malformed slug could potentially cause unexpected route matching or log injection. Low risk given Express routing, but slugs should be validated server-side against `/^[a-z0-9-]+$/` before use.

### OBS-04: No HTTP security headers on dashboard responses
The current server has no `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, or `Referrer-Policy` headers. The spec does not propose adding them. For a tunnel-exposed dashboard, absence of `X-Frame-Options: DENY` means the dashboard could be embedded in a malicious iframe for clickjacking attacks. `Content-Security-Policy` would provide defense-in-depth against any future XSS.

### OBS-05: Job history retention (Open Question 5) has security implications
The spec leaves job history retention as an open question. An unbounded ledger is not just a storage concern — it is a forensic data concern. Long-running job histories containing error messages with system paths, user data references, or API responses may persist indefinitely. A retention policy (e.g., 90 days or 1000 runs per job, whichever comes first) should be established.

### OBS-06: Confirmation prompt for critical-job disable is UI-only
The spec proposes a "confirmation prompt when disabling a critical-priority job." This is entirely a frontend control. The server endpoint has no concept of job criticality — it will disable any job if asked. An attacker with a valid token bypassing the UI faces no server-side barrier to disabling all critical jobs. This is acceptable for a single-user local tool, but the spec should note this is a UX affordance, not a security control.

### OBS-07: CORS missing PATCH method
`middleware.ts` line 14: `'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'`. The spec adds `PATCH /jobs/:slug` and `PATCH /attention/:id`. PATCH is not in the allowed methods list. This will cause CORS preflight failures from the dashboard if the dashboard is ever served from a different port than the API (e.g., during development with a local dev server). The CORS allow-list must be updated to include PATCH.

---

## Scalability Assessment

This is a single-agent local dashboard, not a multi-tenant SaaS. The security posture scales appropriately for that context. However, three dynamics change the threat model as the system grows:

1. **Cloudflare tunnel enables remote access.** The moment the tunnel is active, the threat model shifts from "physical-access-required" to "internet-accessible." ISSUE-SEC-01 (token in WS URL), ISSUE-SEC-05 (public health endpoint), and OBS-04 (missing security headers) become materially more important in tunnel-on scenarios. A tunnel-aware security mode (stricter headers, auth-gated health, WS token redaction) would be valuable.

2. **More mutation endpoints increase blast radius.** The existing dashboard is largely read-only. Adding `POST /jobs/run` and `PATCH /jobs/config` means a stolen token now has operational impact beyond visibility. As more mutation endpoints are added (evolution approve/reject in Phase 3B, autonomy profile changes in Phase 3C), the single-token model becomes increasingly risky. Role separation (read vs. operator tokens) should be considered as a Phase 4+ concern.

3. **Multi-agent / threadline network.** If evolution proposals or autonomy changes can be triggered via the dashboard, and the dashboard token is shared across machines via the multi-machine sync, a compromise on one machine propagates control to all. Currently not a concern, but the trust boundary should be documented.

---

## Recommendations

Priority order:

1. **[HIGH, before implementation]** Specify rate limits for `POST /jobs/:slug/run` and `PATCH /jobs/:slug` in the spec. Add server-side running-state guard for the trigger endpoint.

2. **[HIGH, implementation checklist]** Explicitly audit all `innerHTML` assignments in new JS code. Require `escapeHtml()` on every agent/job-originating string before DOM insertion.

3. **[HIGH, implementation]** Add an explicit allow-list of patchable fields to `PATCH /jobs/:slug` implementation. Only `enabled` (boolean) permitted in this spec.

4. **[MEDIUM, implementation]** Update `corsMiddleware` to include `PATCH` in `Access-Control-Allow-Methods`.

5. **[MEDIUM, spec revision]** Split `/health` into a public ping and an authenticated detail endpoint. Vital signs strip polls the authenticated endpoint post-unlock.

6. **[MEDIUM, Phase 3]** Before implementing the operation log UI, define a server-side response shape that truncates action details and redacts sensitive patterns.

7. **[LOW, future]** Add `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and a basic `Content-Security-Policy` to all dashboard responses. This is a one-time server-level improvement, not per-tab work.

8. **[LOW, operational]** Document the tunnel security tradeoffs in the dashboard spec or operator guide: token-in-WS-URL behavior, public health endpoint, Cloudflare access log exposure.

---

## Score: 7/10

**Justification:** The existing security foundation is competent — timing-safe comparisons, IP-based lockout, localhost CORS, bearer token middleware, and `escapeHtml()` throughout. The spec itself is well-written and operationally motivated. The deductions come from: (a) missing rate limits on new mutation endpoints (a gap that must be filled before code lands), (b) the operation log rendering sensitive decision context without a scrubbing step, (c) no HTTP security headers (a consistent gap across the whole server), and (d) the `PATCH` CORS oversight. None of these are architectural failures — they are implementation-level gaps that are straightforward to address. The spec earns conditional approval pending the rate-limit and allow-list specifications being added before implementation begins.
