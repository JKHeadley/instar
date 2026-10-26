# Review round 1 — Gemini 4 Argon (gemini CLI), 2026-10-25

### 1. Verdict
**Ready with changes.** The Home + grouped-nav + iframe-fallback design is the right 80/20 split, but there are factual errors about the existing nav, an in-memory auth token gap that will break operator write actions across the iframe boundary, and over-engineering in the group-summary layer that should be cut.

---

### 2. Ranked Findings (Factual, Security, Gaps, and Cuts)

#### 1. [Gap / Auth] Operator write actions will break between Console and embedded tabs (`dashboard/index.html:4498`)
* **The problem:** The spec claims sharing `localStorage.instar_token` means "one unlock serves both" and "write actions and PIN gates are exactly the legacy ones." In `dashboard/index.html:4498–4500`, `POST /dashboard/unlock` returns two tokens: `token` (stored in `localStorage.instar_token`) and `operatorSessionToken` (held **only in memory** as a JS variable, never persisted). If the user unlocks in the Console, or reloads an embedded iframe using only `localStorage.instar_token` (`index.html:4534`), `operatorSessionToken` is empty inside the iframe and operator-gated actions will fail or re-prompt.
* **Smallest fix:** Store `operatorSessionToken` (and `operatorSessionExpiresAt`) in `sessionStorage` upon unlock in both Console and legacy dashboard, and hydrate it on load if unexpired.

#### 2. [Factual] The legacy dashboard is not "29 tabs in one flat strip" (`dashboard/index.html:3076-3122`)
* **The problem:** `docs/specs/console-makeover.md` ("Problem") and `console-makeover.eli16.md` state the dashboard has "29 tabs in one flat strip." In reality, `dashboard/index.html:3076–3122` already organizes the 29 tabs into 5 `<div class="tab-group">` elements (*Runtime*, *Work & Delivery*, *Cost & Routing*, *Intelligence & Comms*, *Content & Access*). Furthermore, `dashboard/glance.js:42–60` only tracks 27 tabs in `GLANCE_ADOPTED_TABS` (13) + `GLANCE_GRANDFATHERED` (14), missing newer tabs like `guards` or `attention` referenced in the spec.
* **Smallest fix:** Update the Problem statement to reflect that the current 5 subsystem groups still render as a crowded 29-button strip, and ensure any new tab IDs are reconciled with `TAB_REGISTRY` and `glance.js`.

#### 3. [Gap / Phone & Perf] Embedded legacy `index.html` starts 4 background pollers and a WebSocket on every tab switch (`dashboard/index.html:4509-4514`)
* **The problem:** When `/dashboard?tab=<id>&embed=1` loads in an iframe and auto-authenticates via `localStorage.instar_token` (`index.html:4534–4544`), it unconditionally runs `connectWebSocket()`, `startWaPolling()`, `startVitalSigns()`, and `startPoolSessionsPolling()`, even though the header (`#vitalSigns`) and other tabs are hidden. On a phone over a tunnel, switching embedded tabs will spawn duplicate WebSockets and background timers, hurting battery and the 3-second load target. Also, fixed-height iframes cause double vertical scrollbars on mobile (360px).
* **Smallest fix:** When `embed=1` is present, skip `startVitalSigns()`, `startWaPolling()`, and `startPoolSessionsPolling()` (unless the active tab is `sessions`), and have the iframe post its `scrollHeight` via `ResizeObserver` so the outer console scrolls as one page.

#### 4. [Gap / Deep Links] Query parameters beyond `?tab=` will be dropped by iframe embedding (`docs/specs/console-makeover.md`, Rollout)
* **The problem:** The spec notes agents send deep links like `?tab=files&path=...` and says "the console forwards any `?tab=` it does not render natively to the embedded legacy view." If the console only extracts `tab` and sets the iframe to `/dashboard?tab=files&embed=1`, parameters like `path=...`, `id=...`, or hash fragments are lost. Also, when the user clicks around *inside* the legacy tab, the parent Console URL won't update unless synced.
* **Smallest fix:** Forward the entire `window.location.search` (appending `&embed=1`) and `window.location.hash` into the iframe `src` verbatim.

#### 5. [Cut / 80-20] Cut "Group summaries" (native glance above the embedded tab) (`docs/specs/console-makeover.md`, §2 & Phases)
* **The problem:** Section 2 says: *"Each group page opens with a short native glance summary of its tabs... then the selected tab renders the unchanged legacy view embedded in the console frame."* Many legacy tabs (`commitments`, `machines`, `systems`, `spend`, `tokens`, etc. — `dashboard/glance.js:42–51`) **already** render a `glance.js` summary at the top of their tab panel. Putting a group glance above an iframe that starts with a tab glance creates stacked redundant summaries and pushes the actual tab UI below the fold on a 390px phone screen.
* **Smallest fix:** Cut Group summaries completely. Clicking a group in the nav should just show the group's sub-tab pill bar (with the 1-line group purpose) and immediately render the selected tab below it.

#### 6. [Cut / 80-20] Cut `console-embed.css` reskinning of the 11k-line legacy dashboard (`docs/specs/console-makeover.md`, Aesthetic bar)
* **The problem:** Injecting a new stylesheet (`console-embed.css`) over `dashboard/index.html`—which has ~300 inline style declarations (`dashboard-ux-standard.md:62`) and bespoke dark-theme colors—will create low-contrast text, broken tables, and visual bugs across 29 tabs, especially if you support a light theme in the Console while `index.html` assumes dark backgrounds.
* **Smallest fix:** In `embed=1` mode, only inject CSS to hide `.header` and `#dashVersionBar` and zero out outer padding. Override only the root `--bg` / `--font` CSS variables to match the Console's dark theme, and lock embedded legacy views to dark mode.

#### 7. [Gap / Honesty] "Can't tell" 5-second timeout conflicts with the 3-second tunnel load criterion (`docs/specs/console-makeover.md`, MVP definition #1)
* **The problem:** MVP criterion 1 says: *"Home's six blocks load from live data in under 3 seconds on the tunnel, and each says 'Can't tell: <reason>' when its source fails or times out (5 s)."* If the 6 blocks await `Promise.all` or share a single render pass, one hung endpoint waiting 5s violates the <3s load requirement and blocks the other 5 blocks.
* **Smallest fix:** Specify that each of the 6 Home blocks fetches and renders independently (streaming in as each resolves, showing a skeleton until its individual 4s `AbortController` timeout fires), and never suppresses stale last-known data without labelling its age.

#### 8. [Security] `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'` is safe only if non-dashboard routes on the same origin cannot frame `/dashboard` (`src/server/middleware.ts:690-699`)
* **The problem:** Changing `X-Frame-Options: DENY` to `SAMEORIGIN` and adding `frame-ancestors 'self'` in `dashboardSecurityHeaders` (`src/server/middleware.ts:692–696`) allows *any* page served on the agent's origin to iframe `/dashboard?embed=1` (where the chromeless UI makes clickjacking easier). If the server serves user/agent-authored HTML views or downloaded files on the same origin without a restrictive CSP sandbox, those pages could frame the dashboard.
* **Smallest fix:** Only send `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` when `req.path === '/dashboard'` and `req.query.embed === '1'` (keep `DENY` / `frame-ancestors 'none'` on `/dashboard/console/` and all other paths), and verify that any agent-authored preview/file routes on the server send `Content-Security-Policy: sandbox`.
