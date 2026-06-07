# Dashboard Subscriptions tab + Pending Logins panel (P2.2)

<!-- bump: minor -->

## What Changed

Added a **Subscriptions** tab to the dashboard — the visual surface for the
multi-account Subscription & Auth pool (P1.1–P2.1). It shows, per account: the
nickname, a friendly status, and live quota bars for the 5-hour and weekly
windows with a "resets in …" countdown. A **Pending Logins** panel below lists
any in-flight enrollment — the device code / verification URL (shown as copyable
text, never a live link) with its TTL countdown and how many times it has been
re-issued.

The tab is a self-contained browser-native ESM module (`dashboard/subscriptions.js`)
served statically, registered in `index.html` exactly like the Process Health and
Preferences tabs (lazy dynamic-import, start/stop on tab activation, polled every
30s). It consumes the existing `GET /subscription-pool` and
`GET /subscription-pool/pending-logins` routes — no new server routes, no `src/`
change. When the pool isn't set up the routes answer `{ enabled:false }` and the
tab shows a friendly "not set up yet" message (never an error).

It carries the same load-bearing display-safety contract as the Process Health
tab: every dynamic value is sanitized (NFKC fold + control/bidi/chrome-glyph
strip + grapheme cap) before the DOM, all writes are `textContent` only, and the
only dynamic attribute (a quota-bar width) comes from a clamped 0–100 integer.

Coverage: 26 tests across three tiers — render unit tests (sanitize/clamp/
countdown/renderers + XSS-survives-as-inert-text), a controller integration test
(jsdom + injected fetch/timers: render, feature-dark, XSS through the controller,
fetch-failure resilience, visibility gating), and an e2e feature-alive test that
boots a real server with the production routes and drives the shipped controller
against it (accounts + pending logins render; feature-off → friendly copy).

## What to Tell Your User

There's a new **Subscriptions** tab on your dashboard. It shows each of your
subscription accounts, how much of each is left (5-hour and weekly) and when it
resets, and any logins still waiting for you to approve on your phone — with the
code and a countdown. Open it from any device with your dashboard PIN.

## Summary of New Capabilities

- **Subscriptions dashboard tab** — per-account live quota bars (5h + weekly) with
  reset countdowns + friendly status, on any device behind the dashboard PIN.
- **Pending Logins panel** — in-flight enrollment codes / verification URLs (as
  copyable text) with TTL countdown + re-issue count.
- **Mobile-responsive + safe** — sanitized, `textContent`-only rendering; no live
  links; reuses the Process Health tab's hardened display contract.
