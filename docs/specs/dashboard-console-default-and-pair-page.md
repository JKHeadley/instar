---
title: "The console becomes the dashboard's front door, and a waiting phone's code gets its own page"
slug: "dashboard-console-default-and-pair-page"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "dashboard-console-default-and-pair-page.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched); the product decisions are Justin's own, 2026-11-03 11:54 PST"
review-convergence: "2026-11-03T21:47:57.995Z"
review-iterations: 5
review-completed-at: "2026-11-03T21:47:57.995Z"
review-report: "docs/specs/reports/dashboard-console-default-and-pair-page-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# The console becomes the dashboard's front door, and a waiting phone's code gets its own page

## Problem statement

Operator decisions, 2026-11-03 11:54 PST (topic 136110), right after pairing an iPhone with the freshly installed Cirrus through the legacy dashboard:

1. "we should officially swap Instar to the new dashboard at this point as the default (still support accessing the legacy dashboard)". Today `/dashboard` serves the legacy page and the console lives at `/dashboard/console/`. The CLAUDE.md template says the legacy dashboard "stays the default until the operator calls the console MVP"; this is that call.
2. "the flow should be a direct link to the appropriate phone tab/page with the code visible and a copy button available". Today a Telegram-less operator opens `/dashboard`, unlocks with the PIN, opens the Phones tab, then taps Waiting to see the code. The console has no Phones page of its own (its tile links to the legacy tab).

Every safety property of mobile pairing stays: the code is shown only to a PIN-unlocked operator session, the agent never relays it, and the pairing stays bound to the host the phone redeemed on. Two findings from the parked one-step draft (`docs/specs/drafts/mobile-pairing-one-step.full-draft.md` in the agent home, rounds 2–3 and 6) apply to any link-opened page that asks for the PIN, and are handled here (§3.4, §3.5): phishing, and a strict content policy that a variant URL could bypass.

## What exists (main 03e31cf59)

- `AgentServer` registers, before auth: `GET /dashboard` → legacy `dashboard/index.html` (no-cache, ETag); the desktop page routes; `mountDashboardPreview`; then `express.static('dashboard/')` on `/dashboard`. Express routes are case-insensitive and ignore one trailing slash; `express.static` decodes the path and, on macOS, the file system is case-insensitive.
- `dashboardSecurityHeaders` (middleware) gives every `/dashboard*` response `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, and a loose CSP (`'unsafe-inline'`, `cdn.jsdelivr.net`), except the two exact desktop paths.
- `/dashboard/unlock` (PIN) answers `{ token, operatorSessionToken, operatorSessionExpiresAt }` (15-minute session, shared 5-per-IP/20-global lockout). `/dashboard/unlock-check` tells a page whether this connection may unlock.
- `GET /mobile/pairing-approvals` (Bearer + `X-Instar-Operator-Session`) returns waiting dashboard-path phones with their plaintext code; `POST /mobile/pairing-approvals/:id/decline`; `GET /mobile/devices`; `POST /mobile/devices/:id/revoke`.
- Redeem (`POST /mobile/pairing-codes/redeem`, public, local TLS on an eligible host) answers `{ deviceId, agentName, status:'pending', approval:'dashboard'|'telegram', codeFormat }`. Mint (`POST /mobile/pairing-codes`, Bearer) answers `{ code, expiresAt, link, originKind, person }`.
- The console (`dashboard/console/`) unlocks with the PIN, keeps only the Bearer token in `localStorage` (shared with legacy), and asks for the PIN again (`askPin`) for operator-session actions. Its links to legacy tabs are `/dashboard?tab=<id>` (`nav-model.js` `legacyHref`), and its "Legacy dashboard" links are `/dashboard`.

## Proposed design

### 3.1 `/dashboard` opens the console

A new module `src/server/dashboardEntry.ts` exports `mountDashboardEntryRoutes(app, { dashboardDir })`, used by `AgentServer` in place of today's `/dashboard` route and by the integration tests (no copied route code):

- `GET /dashboard` (and its case and trailing-slash variants, which Express routes to the same handler):
  - **With a non-empty query string** → `302` to `/dashboard/legacy` + the same query string. Every existing deep link (`?tab=files&path=…`, `?tab=phones`, links in old Telegram messages, the file-link API, legacy's own `?tab=` navigation) keeps opening the legacy tab it named.
  - **Without one** (no `?`, or a bare `?`) → `302` to `/dashboard/console/`.
  - `302`, never `301`: browsers keep a 301 indefinitely, which would make a revert invisible to them. `Cache-Control: no-store` on the redirect.
  - A fragment survives: browsers carry the original `#…` across a redirect whose `Location` has none.
- `GET /dashboard/legacy` → the legacy `index.html`, with today's headers (no-cache, ETag). `/dashboard/legacy/` redirects to `/dashboard/legacy` (query kept), so the page has one address and its relative URLs always resolve under `/dashboard/`. The legacy page loads its assets by absolute path or relative to `/dashboard/`, both of which resolve the same from `/dashboard/legacy`, and its own `history.replaceState` keeps `location.pathname`.
- `/dashboard/index.html` is still served by the static mount (legacy); nothing else under `/dashboard/` moves.
- Console links: `legacyHref(id)` → `/dashboard/legacy?tab=<id>`; the nav's "Legacy dashboard" item, the header's "Legacy" chip, the group-page foot note and the `<noscript>` link → `/dashboard/legacy` (one constant, `LEGACY_DASHBOARD` in `nav-model.js`). The legacy header's "Try the new console" link stays.
- Links the server hands out that should now open the console's own pages instead of legacy tabs: the pinned Telegram dashboard message's quick links (`TelegramAdapter.formatDashboardMessage`: Sessions → `/dashboard/console/#/work/sessions`, Files → `/dashboard/console/#/settings/files`) and the truncated-message hint (`routes.ts`, was `?tab=dropzone`; sending text and files now happens in each session's message box on the console's Sessions page, so the hint points there and says so). Links with a query that name something only legacy has (`?tab=files&path=…` from the file-link API, the ratification link, `?tab=mandates&…`, `?tab=subscriptions`, `?tab=feedback-drain`) stay as they are and open legacy.
- Links to a bare `/dashboard` (the desktop page's "← Dashboard", the maturation board's `<noscript>`, `UpgradeNotifyManager`, the startup log) now land on the console. That is intended. Console pages already published to the dashboard preview keep their old legacy links until they are republished, and those links still work through the redirect.
- **Install** (`src/commands/install.ts`): the Telegram-less closing line becomes "To see it, open `<origin>/dashboard/pair` on your phone and enter your PIN. Tap Copy, then paste it into the app." (was: open `/dashboard`, enter the PIN, open Phones).
- The addresses live in one dependency-free module, `src/server/dashboardPaths.ts` (`CONSOLE_PATH`, `LEGACY_PATH`, `PAIR_PAGE_PATH`, `codePageUrlForDevice`, `codePageUrlForOrigin`, `consolePageUrl`), shared by the routes, the pairing routes, the CLI and the Telegram adapter.
- Every agent gets this on update with no config: it is server behaviour. No opt-out setting: the legacy page is one link away, and a revert restores the old default.

### 3.2 The pairing code page: `/dashboard/pair`

One small standalone page that does the whole Phones job and is the console's Phones page.

- **Files** live in a new top-level `dashboard-pair/` (`pair.html`, `pair.js`, `pair-model.js`, `pair.css`), **outside** the static `dashboard/` mount, so no alias the static server accepts can reach them. `package.json` `files` gains `dashboard-pair`; the directory resolves like `resolveDashboardDir()` (package root installed, repository root in source).
- **Routes**: `mountPairPage(app, { pairDir })` in `dashboardEntry.ts` registers `GET /dashboard/pair` (the page), `/dashboard/pair.js`, `/dashboard/pair-model.js` and `/dashboard/pair.css`, before the preview mount and the static mount. Each handler sets, **in the handler**, all four dashboard headers: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (the middleware matches `/dashboard` case-sensitively, so it misses `/Dashboard/pair`, which the route still answers), and, replacing the loose policy the middleware may already have written, `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` and `Cache-Control: no-store`. Every URL that reaches one of these handlers (any case, a trailing slash) gets the strict policy; every other spelling (`/dashboard/pair.html`, `/dashboard/p%61ir`, `/dashboard/pair/x`) falls through to the static mount, which has no such file, and then to the auth middleware, which refuses it (401). Either way the page is never served without the strict policy. The page references its assets by absolute path.
- **The page** (`pair.js`, an ES module; no inline script, no third-party script, every dynamic value via `textContent`):
  1. Title: "Pair a phone with this agent", and the address it is on (`location.host`) in large type under it.
  2. Calls `/dashboard/unlock-check`; if refused, shows the reason and the secure address (same rule and wording as the console), and no PIN box.
  3. One PIN box. `POST /dashboard/unlock`; the Bearer token and operator session are kept **in page memory only** (never `localStorage`), and forgotten on a refused PIN or at session expiry. The session's remaining life is measured on the server's clock (the unlock answer's `Date` header against `operatorSessionExpiresAt`), less a 5-second margin for transit and the header's one-second precision, capped at 15 minutes, and counted down on the page's monotonic clock. So a phone clock that is off, or changed meanwhile, does not lock the page; the page forgets a code within a few seconds before the server's deadline, never after it, except when transit took longer than the margin, which the next call's 403 then catches. **Every authenticated call** (the approvals read, the paired-phones read, decline, remove) goes through one wrapper that reads the answer's headers and body under one 15-second limit and one cancellation (the reset cancels it), then hands back parsed data only if the session that made the call is still the live one and its deadline has not passed; any 403 runs the reset. Each refresh belongs to the unlock that started it: a reset releases the page from a refresh still unwinding, so polling resumes at the next unlock. **One reset** clears the credentials, every rendered code and Copy button, and the timers; it runs on a 403, from a one-shot timer at the session's `operatorSessionExpiresAt` (so it does not wait for a poll), when a hidden page becomes visible after the deadline, and when Copy is tapped after it. A page the browser suspended runs the reset as soon as it runs again, before it renders or copies anything. An answer that arrives after its session was reset, or after the deadline, is dropped. A code is never shown without a fresh PIN unlock on this page load, even when the browser already holds the console's stored token.
  4. Waiting phones from `GET /mobile/pairing-approvals`. If the fragment names a device (`#d=<deviceId>`, read on the client only) and that device is waiting, only it is shown; if it is not waiting: "That phone is no longer waiting: it was paired, declined, or its link expired." Each waiting phone shows: its name and whose phone it is, minutes left, the key fingerprint ("check the app shows the same"), the **code in large monospace type**, a **Copy** button, the line "Paste it into the Instar app on that phone. Never send it to anyone, including me.", and "Not my phone — decline".
  5. Copy uses `navigator.clipboard.writeText` (available on the secure origins this page runs on) and says "Copied"; when the clipboard is refused it selects the code and says "Press and hold the code to copy it".
  6. None waiting: "No phone is waiting. Open the pairing link on the phone; its code appears here by itself." `GET /mobile/pairing-approvals` already answers `{ approval: approvalPath(), approvals }`; with `approval:'telegram'` there: "This agent sends pairing codes to your private Telegram chat."
  7. Paired phones (`GET /mobile/devices`), each with "Remove this phone" (`confirm()`, then revoke), as the legacy tab has.
  8. The waiting phones (and their codes) render as soon as the approvals read answers; the paired-phones list is its own read with its own guard ("Reading the paired phones…" until it answers), so a slow or failed list never holds a code or a later refresh back. A phone declined on this page leaves it at once and is never drawn again, even by a read that started before the decline. The two calls made before there is a session (`/dashboard/unlock-check`, `/dashboard/unlock`) have the same 15-second limit, body included: a slow check still shows the PIN box (the server decides), and a slow unlock says "The agent did not answer. Try again." with the button enabled again. Refresh every 10 s while visible (polling starts only with a live session); a refresh asked for while one is running runs once more after it, so a declined or removed phone leaves the page at once; a 403 runs the reset above; "Show every waiting phone" drops the fragment in place, without a reload (which would ask for the PIN again); a 503 says pairing is off; after 5 failed reads in a row: "Lost contact — Retry".
- **Console**: `NATIVE_PAGES.phones = '/dashboard/pair'`, so the Phones tile (People group) opens it; its description says the code shows there after the PIN.

### 3.3 The link the agent and the app hand out

- **Redeem**, dashboard path only: the answer gains `codePageUrl: "https://<host>/dashboard/pair#d=<deviceId>"`, where `<host>` is the request host redeem has already checked (local TLS and an eligible pairing host, the host the code was bound to). The Telegram path is unchanged (no field).
- **Mint**: when `approvalPath()` is `dashboard`, the answer gains `codePageUrl: "<origin>/dashboard/pair"` with the same origin as `link`. Otherwise no field.
- The URL carries no secret: the device id sits in the fragment, which the browser never sends to the server.
- **App half** (topic 134088, posted FINAL in `.instar/vm-test/app-coordination.md`): when a redeem answer has `approval:'dashboard'` and a `codePageUrl` whose origin equals the origin the app just redeemed against, the confirm screen offers "Show my code" opening that URL in the browser. The app never opens a `codePageUrl` with another origin, and never fills the PIN.

### 3.4 Phishing (from the draft's rounds 2–3)

A page that asks for the PIN and is reached from a link can be imitated: a look-alike at another address collects the PIN, which unlocks the real dashboard. This page adds no new form of that risk, and narrows the ways to reach it:

- The page is on the agent's own address: the same one the operator already uses for the dashboard, reached the same way, and it shows that address as its title.
- The agent sends the code-page link only where it sends the pairing link (a topic whose verified operator is the asker), and never sends the PIN in the same message (template rule, §3.6).
- The app opens only a code page on the origin it just paired against (§3.3), so a link in a message cannot redirect it.
- The page approves nothing: it shows a code that only helps the phone already waiting on this agent, plus the fingerprint to compare. The second-order phish ("send me the code you see") is answered by the page's own warning, by the agent never asking for the code, and by the existing leak scan, which voids a code that turns up in inbound text.
- Residual risk, unchanged from today and accepted in the draft's round 3: an operator who types the PIN into a look-alike page at the wrong address gives that PIN away, exactly as with today's dashboard unlock.

### 3.5 Content policy on variant URLs (from the draft's round 6)

The strict policy is set by the page's own handlers (§3.2), and the files are outside the static mount. So the page can only be reached through those handlers, and every response from them carries the strict policy. The integration test enumerates the variants (case, trailing slash, `.html` suffix, percent-encoding, a path inside `/dashboard/console/`) and asserts each one either carries all four strict headers or is not a 200 and does not contain the page's HTML. It names no particular refusal status.

### 3.6 Agent awareness and migration parity

- **Console bullet** (`templates.ts`): a new bullet with a new marker, `The console is the dashboard's front door`: `/dashboard` opens the console; the legacy dashboard is `/dashboard/legacy`, and every `?tab=` link opens there; proactive: send `{tunnelUrl}/dashboard` and the PIN. `PostUpdateMigrator.migrateClaudeMd`: a line containing the old marker (`The new console runs beside the dashboard`) is replaced with the new bullet; if neither marker is present, the new bullet is inserted where the old one was (after the dashboard Features line). The preview bullet's anchor accepts either marker. A second run changes nothing (the old marker is gone).
- The fresh lines of the pairing-without-Telegram section never contain `Phones` (a unit test asserts it), which keeps the rewrite below idempotent if the wording changes later.
- The console-bullet rewrite runs before the "insert if missing" check, and both look for the new marker, so an agent already migrated never gets a second bullet.
- **Pairing without Telegram** section: the opening paragraph, the "Send the operator…" bullet and the "When to use" bullet name the code page instead of the Phones tab: send the pairing link plus the mint answer's `codePageUrl` (never with the PIN); the operator opens the pairing link on the phone, then the code page, unlocks, and copies the code into the app. The migrator replaces each of the three lines only when it starts with its shipped prefix **and** still contains `Phones` (the fresh lines do not), so it is idempotent, and it composes with the word-code rewrite in either order (that rewrite replaces the opening paragraph with the fresh line, which already names the code page).
- No config change.

### 3.7 Multi-machine posture

The redirect and the page are per-machine and stateless. A waiting code lives in the memory of the machine that issued it (unchanged); the code-page link uses the host the phone redeemed on, which reaches that same machine, so the page reads the code where it lives. No new state is created.
machine-local-justification: physical-credential-locality (same object as mobile-pairing-word-code §5: the pending code is bound to the machine serving the host the phone paired against).

## Decision points touched

| Decision point | Class | Justification |
|---|---|---|
| `/dashboard` redirect target (query string present → legacy, absent → console) | invariant | Deterministic routing on a URL property; no competing signals. |
| Strict CSP on the pair page, applied by its handlers | invariant | Fixed security header on fixed routes. |
| `codePageUrl` host = the redeem's already-validated request host (mint: the minted link's origin) | invariant | Reuses the existing host checks; adds no new acceptance rule. |
| Who may see a code (unchanged) | invariant | Still `GET /mobile/pairing-approvals`, Bearer plus operator session; this spec adds no gate and changes none. |

## Tests

- **Unit**: `pair-model.js` (fragment parsing, which phones are shown for a given `d`, code formatting for word and digit codes, minutes left, copy-fallback wording); `nav-model` (`legacyHref` and `NATIVE_PAGES.phones`); DOM test of `pair.js` with a fake fetch: no code before unlock, the code and Copy after unlock, the token never written to `localStorage`, a 403 clears codes and shows the PIN box, Copy success and refusal; migrator: old console bullet → new and idempotent; pairing-without-Telegram lines in each shipped form (original, `STALE_CODE_LINE`, post-word-code, pre-word-code `6-digit`), in either order with the word-code rewrite, a second run changes nothing; fresh `generateClaudeMd` contains the new marker and no old marker.
- **Existing tests rewritten onto the shared routes** (never by restoring the old route): `tests/integration/console-static-serving.test.ts` and `dashboard-static-cache.test.ts` (they copied the `/dashboard` route and expect a 200 with the legacy page; they now mount `mountDashboardEntryRoutes` and read the legacy page at `/dashboard/legacy`); `console-nav-model`, `console-dom` and `console-costs` unit tests that assert `/dashboard?tab=`; the pairing-without-Telegram and console awareness tests; the Telegram dashboard-message test and the install test, where they assert the old wording.
- **Integration** (`mountDashboardEntryRoutes` + `mountPairPage` + the real middleware and static mount): the redirect matrix (`/dashboard`, `/dashboard/`, `/DASHBOARD`, `?tab=files&path=x` → legacy with the query intact); `/dashboard/legacy` serves the legacy page; `/dashboard/console/` unchanged; the CSP variant matrix of §3.5; redeem on the dashboard path returns `codePageUrl` with the request host and `#d=<deviceId>`, the Telegram path returns none; mint returns `codePageUrl` only on the dashboard path.
- **E2E** (production init path through `AgentServer`): `GET /dashboard` → 302 `/dashboard/console/`; `GET /dashboard/legacy` → 200 legacy HTML; `GET /dashboard/pair` → 200 with the strict CSP; `GET /dashboard/pair.js` → 200 JavaScript.
- **Live** on Cirrus after release: the redirects, the strict header, and a real phone's code shown on `/dashboard/pair` after a PIN unlock.

## Maturation plan

- **test-agent-live:** the E2E on the production init path (a real AgentServer): `/dashboard` → console, `/dashboard/legacy` → legacy, `/dashboard/pair` strict, and the page's unlock + approvals calls answering 200 with an operator session.
- **dev-agent-live:** live on release (no gate; the operator decided the default). On Cirrus, the Telegram-less test agent: `GET /dashboard` 302 to the console, `/dashboard/legacy` 200, `/dashboard/pair` 200 with the strict policy, and a real waiting phone's code shown on the page after a PIN unlock.
- **fleet:** the same release; ungated (Frontloaded Decision 6).
- **graduation criterion:** on Cirrus after the release, all four of: the bare `/dashboard` redirect, the legacy page loading at `/dashboard/legacy`, the strict `Content-Security-Policy` on `/dashboard/pair`, and one real phone's code shown there after a PIN unlock. If any is missing, the criterion is not met.
- **dark-window:** none — live on release. If the Cirrus check has not passed within 3 days of the release, the reason and a new date are recorded in topic 136833.

## Rollback

Revert the PR. `/dashboard` serves the legacy page again (a 302 is never cached permanently). `/dashboard/legacy` and `/dashboard/pair` then stop working, including code-page links already handed to an app or sent in a message; a phone waiting at that moment needs its code from the restored legacy Phones tab (or a new link). Agents already migrated keep CLAUDE.md lines that name those two pages, so the revert PR also ships the reverse line rewrite (the same prefix-and-marker rule, run the other way).

## Open questions

*(none)*

## Frontloaded Decisions

1. Query string → legacy, plain `/dashboard` → console: keeps every existing deep link working without mapping each legacy tab to a console page.
2. 302, not 301: keeps a revert effective.
3. The code page is a standalone strict page, not a console route: the console needs `cdn.jsdelivr.net` (Files page) and so cannot carry the strict policy as a whole.
4. The page asks for the PIN on every load and keeps nothing in storage, even when the console's token is stored: the code is the one secret here and the operator asked for "after the PIN unlock".
5. The device id rides in the fragment, never the query, so no server or proxy log carries it.
6. No opt-out setting for the default: the legacy page is one link away (operator: "still support accessing the legacy dashboard").
