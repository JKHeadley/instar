---
title: "Console phone mode: one page inside the Instar app's frame"
slug: "console-phone-mode"
author: "echo"
parent-principle: "One app, less text"
eli16-overview: "console-phone-mode.eli16.md"
status: "draft"
approved: true
approved-by: "echo, Tier 1, for the Instar iPhone app redesign (parent session, topic 139417, 2026-11-05): dashboard pages shown inside the app's own frame with the console's bars removed. Display only; nothing changes without phone=1."
review-convergence: "2026-11-05T23:30:00.000Z"
review-iterations: 1
review-completed-at: "2026-11-05T23:30:00.000Z"
review-report: "not applicable: Tier 1 display change, a URL flag read once per load."
---

# Console phone mode

## Problem

The Instar iPhone app embeds the web console in a WKWebView. Its new design shows a console page inside the app's own frame (its own title bar and navigation). Today the console always draws its own top bar (brand, Legacy chip) and bottom nav (sidebar on wide screens), so the app shows two sets of bars.

## Contract

- `/dashboard/console/?phone=1#/<page>` shows only that page's content: no top bar, no bottom or side nav, no Legacy chip, no "Legacy dashboard" link, no page switcher.
- `phone=1` in the hash's own query (`#/accounts?phone=1`) does the same, because the app's ticket sign-in loads the console home and may only control the hash.
- Sticky for the page load: once on, hash changes stay in phone mode.
- `<page>` is either a full console path (`#/capacity/accounts`) or, in phone mode only, a short name: promises, plans, schedule, development, maturation, ideas, sessions, pace, machines, health, accounts, costs, messages, agents, mandates, secrets, allowed, learned, inside, files. `pace` is a phone-only page holding the Work page's Pace card.
- Data loading, the 30-second refresh, sheets, actions and sign-in (PIN or ticket) are unchanged.
- Safe-area insets are respected; the top gap is small (the page sits under the app's own title bar), and nothing reserves room for the missing nav.
- Without `phone=1` nothing changes, including short names (they keep opening Home as today).

## Design

- `nav-model.js`: `isPhoneMode(search, hash)`, `pagePath(path, phone)`, `PHONE_PAGE_ALIASES`, `PHONE_ONLY_PAGES` — pure, unit tested.
- `console.js`: a module flag set at `start()` from the page query or hash query and re-checked in `route()` (only ever turned on). `renderShell` draws only `<main>` in phone mode; group pages skip the legacy foot note; `<html data-phone>` carries the mode to CSS.
- `pace.js`: `paceCard` takes optional `onMissing` / `onShown` callbacks so the phone Pace page can say when the card is unavailable and refresh without a blank flash.
- `console.css`: `:root[data-phone]` sets the nav reserve to the bottom safe area, the top-bar offset to 0, one column at every width, and safe-area padding on `<main>`.

## Decision points touched

None. This is display only: no gate, no block or allow decision.

## Multi-machine posture

Machine-local by design: a page-load display flag in the browser. No state, no notices, no generated URLs.
