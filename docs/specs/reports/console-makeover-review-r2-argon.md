# Review round 2 — Gemini 4 Argon (gemini CLI), 2026-10-25

### 1. Verdict
**Ready.** The Round 2 spec resolved every major Round 1 blocker: dropping iframe embedding, group summaries, and legacy CSS reskinning eliminated the clickjacking surface, `operatorSessionToken` handoff bugs, background poller duplication, and 29-tab restyle risk in one stroke. Only minor factual and edge-case details remain to watch during implementation.

---

### 2. Ranked Findings (Factual, Security, Gaps, and Cuts)

#### 1. [Factual / Routing] `/dashboard/console/` needs an explicit route or trailing-slash redirect (`src/server/AgentServer.ts:1233–1242`)
* **The problem:** The spec states the console is served at `/dashboard/console/` by the existing `express.static(dashboardDir, DASHBOARD_STATIC_OPTIONS)` middleware (`AgentServer.ts:1242`) and advertised in `CLAUDE.md`. While `express.static` serves `dashboard/console/index.html` and redirects `/dashboard/console` to `/dashboard/console/`, any future client-side sub-path or missing trailing slash without `redirect: true` (default) should be explicitly tested alongside the `/dashboard` explicit `sendFile` handler (`AgentServer.ts:1233`).
* **Smallest fix:** In the Tier 2 integration test, assert that both `GET /dashboard/console` and `GET /dashboard/console/` resolve cleanly with `dashboardSecurityHeaders` (`X-Frame-Options: DENY`) and `Cache-Control: no-cache`.

#### 2. [Factual / Registry] Navigation table lists 27 legacy tabs while "Problem" says 29 (`docs/specs/console-makeover.md`, §2 & `dashboard/index.html:3077–3122`)
* **The problem:** The spec's Problem section states the dashboard has 29 tabs, and MVP criterion #2 requires every legacy tab to be reachable in two taps from Home. However, the `dashboard/index.html:3077–3122` nav excerpt and the spec's Section 2 Navigation table list 27 tabs (6 + 3 + 4 + 3 + 9 + 2 in detail links = 27: `Sessions, Jobs, Commitments, Projects, Initiatives, Blockers, Send Content, Machines, Health, Subscriptions, Resource Usage, Tokens, Spend, Threadline, Message origins, Mandates, Secrets, Features, Preferences, Files, Insights, PR Pipeline, Evidence, Routing Map, LLM Activity, Throughput, Integrated-Being, Process Health, Feedback Drain` — which actually totals **28** in the Section 2 table: 7 in Work + 6 in Capacity + 4 in People + 3 in Settings + 9 in Under the hood = **29**). The counts in the spec are consistent (29), but `dashboard/glance.js:42–60` only lists 28 (`GLANCE_ADOPTED_TABS` has 14, `GLANCE_GRANDFATHERED` has 14).
* **Smallest fix:** Ensure the unit test for MVP criterion #2 ("every legacy tab is reachable in two taps") reads the canonical `TAB_REGISTRY` from `dashboard/index.html` rather than hardcoding 29, so any tab discrepancy is caught automatically.

#### 3. [Gap / Auth] Raw Bearer token fallback when `/dashboard/unlock` returns 404 (`docs/specs/console-makeover.md`, §3 & `dashboard/index.html:4493–4504`)
* **The problem:** Section 3 says the console PIN screen "calls the existing `POST /dashboard/unlock` and stores only the bearer token, exactly as legacy does." In `dashboard/index.html:4493–4504`, if `/dashboard/unlock` is not configured or returns 404, legacy falls back to treating the user's input as a raw Bearer token (`token = pin`) before validating it. Also, `AgentServer.ts:1254` returns `503` when `dashboardPin` is not configured. If the console only handles `200`/`403`/`429` from `/dashboard/unlock`, agents without a PIN configured won't be able to log in with a raw token.
* **Smallest fix:** Mirror legacy's fallback in the console's login handler: if `/dashboard/unlock` returns `404` or `503`, try the entered string directly as `Authorization: Bearer <input>` against `GET /sessions`.

#### 4. [Gap / Phone UX] Two-card-high dual-endpoint failures on "What I'm doing" and "What I'm allowed to do" (`docs/specs/console-makeover.md`, §1)
* **The problem:** Two Home cards depend on two endpoints each: "What I'm doing" fetches `/sessions?scope=pool` and `/parallel-work/activities`; "What I'm allowed to do" fetches `/guards` and `/mandate`. The table states "Can't tell when: request fails", but doesn't specify what happens when *one* of the two endpoints succeeds and the other fails (e.g., `/sessions` succeeds but `/parallel-work/activities` fails, or `/guards` succeeds but `/mandate` fails). Blank-failing the whole card hides working session or guard data.
* **Smallest fix:** Treat a single-endpoint failure on a two-endpoint card as **Partial**: render the half that answered (e.g., live sessions without topic focus, or guards summary with "mandates: can't tell") rather than replacing the whole card with "Can't tell".

#### 5. [Cut / 80-20] Cut light theme from MVP (`docs/specs/console-makeover.md`, Aesthetic bar)
* **The problem:** The Aesthetic bar states: *"Dark is the default (as on the site); a designed light theme is one toggle away and remembered per browser."* However, `instar.sh` is dark-only (`#0a0e17`), and every tap on a group tile navigates via an ordinary link to `/dashboard?tab=<id>`, which is hardcoded dark. Toggling the console to light mode means every click into an actual tool flashes the user back into a dark legacy page, and doubles the visual QA surface across the 3 screenshot critique passes.
* **Smallest fix:** Ship dark theme only for MVP (matching `instar.sh` and legacy `/dashboard`), and defer the light theme toggle until legacy tabs are natively rebuilt.
