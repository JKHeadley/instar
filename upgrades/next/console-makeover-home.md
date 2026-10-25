# A new console beside the dashboard: one Home screen with honest state

## What Changed

- `dashboard/console/` (new): a read-only console served at `/dashboard/console/` by the existing dashboard static route, with the same security headers (`X-Frame-Options: DENY`, same CSP) and revalidation. It shares the legacy dashboard's stored token and PIN unlock (`POST /dashboard/unlock`; a raw token is accepted when no PIN is configured, as legacy does). It never stores the operator proof and has no write actions.
- Home: one headline sentence plus six cards, each fetched and rendered on its own from existing routes — held replies (`/health`), what needs the operator (`/attention?scope=pool`), open promises (`/commitments?scope=mesh`, with the tracker's active rule applied to own and replica rows), live sessions (`/sessions?scope=pool`), machine states (`/pool`, explicit precedence: peer-offline, no reading, not answering, quiet, struggling, live, always with the evidence age) and safety checks (`/guards`, `/mandate`). A source that fails, times out, is disabled or answers without the needed fields shows "Can't tell" with the reason; partial pool coverage and out-of-date replicas are labelled; the last good reading is kept, with its age, when a refresh fails. "All quiet." is only shown when every card is observed and fine.
- Navigation by question: Home, Work, Capacity, People, Settings (a bottom bar on phones, a sidebar on desktop). Group pages are static directories of tiles; each opens the unchanged legacy tab as an ordinary link (`/dashboard?tab=<id>`). Every tab in the legacy `TAB_REGISTRY` is covered exactly once (unit-tested against the registry).
- Visual identity taken from the instar.sh stylesheet: `#0a0e17` ground with the faint teal grid, teal accent and gradient, slate scale, Inter and JetBrains Mono (self-hosted, SIL OFL, because the dashboard CSP loads fonts from `'self'` only). Dark only for now.
- `dashboard/index.html`: one header link, "Try the new console". Nothing else in the legacy dashboard changed; it stays the default.
- `src/scaffold/templates.ts` + `PostUpdateMigrator.migrateClaudeMd`: one CLAUDE.md bullet naming the console URL (content-sniffed, idempotent).

## What to Tell Your User

There's a new console next to your dashboard, built to look like the Instar website. Its first screen tells you in one sentence whether anything needs you, then shows what is waiting on you, the promises I'm holding, what I'm doing on each machine, how each machine is doing and which safety checks are on. When it can't see something it says so instead of pretending all is fine. Every tab you know is still there, one tap away, and the old dashboard stays the default until you decide the new one is ready.

## Summary of New Capabilities

- `/dashboard/console/` — the new read-only Home screen and grouped navigation, alongside the unchanged `/dashboard`.

## Evidence

Unit: `console-home-model.test.ts` (45 cases: HTTP failure, timeout, `enabled:false`, null `observedAt`, missing fields, partial pool, stale replica, machine-state precedence and boundaries, headline rules), `console-nav-model.test.ts` (registry coverage), `console-claude-md-awareness.test.ts` (template + idempotent migration). Integration: `console-static-serving.test.ts` (served with dashboard headers, trailing-slash redirect, assets and fonts, no iframe, legacy link). E2E: `console-home-lifecycle.test.ts` (a real AgentServer serves the console; every Home route answers through the real auth stack and maps to an honest card). Live: phone (390 px) and desktop (1440 px) screenshots against the Mac Studio's live data, no sideways scroll at 390 px. Reviewed in three rounds by GPT-6 Astra and Gemini 4 Argon (`docs/specs/reports/console-makeover-review-r*`).
