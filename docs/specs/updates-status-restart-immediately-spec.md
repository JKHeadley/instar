---
title: "Surface restartImmediately in GET /updates/status (close the #641 observability gap)"
date: 2026-06-01
author: echo
review-convergence: internal-plus-conformance-2026-06-01
approved: true
approved-by: Justin
approved-via: "Telegram topic 13435 (2026-06-01): the restart-immediately directive + 'fix gaps as proper fleet PRs' — this closes Echo's own incomplete #641 claim ('surfaced in GET /updates/status'), found while verifying the work live."
eli16-overview: updates-status-restart-immediately-spec.eli16.md
---

# Surface `restartImmediately` in GET /updates/status

## Problem

PR #641 (primary-developer mode) added `restartImmediately` to
`AutoUpdaterStatus` and `AutoUpdater.getStatus()`, and its upgrade guide
claimed the flag is "surfaced in GET /updates/status". But the
`/updates/status` route builds a **hand-picked** response object and only
`Object.assign`s a specific subset of `auto.getStatus()` fields — and
`restartImmediately` was not in that list. So `GET /updates/status` returned no
`restartImmediately` field, and the flag's live state was not observable via the
endpoint. The claim was incomplete; the functional behavior worked, the
observability did not. (Found live on 1.3.180 while verifying #641 deployed:
`/updates/status` read no field even with the flag set true.)

## Decision

Add `restartImmediately: auto.restartImmediately` to the `/updates/status`
route's `Object.assign`, so the route echoes the value that `getStatus()`
already returns. Default false → fleet responses simply gain a
`restartImmediately: false` field; the developer's agent shows `true`.

## Design

One line in `src/server/routes.ts` (`router.get('/updates/status')`): inside the
`if (ctx.autoUpdater)` block, add `restartImmediately: auto.restartImmediately`
to the assigned object (the value already exists on `AutoUpdaterStatus` from
#641). No other change. When no `autoUpdater` is wired, the field is simply
absent (unchanged behavior).

## Safety / blast radius

Pure additive observability — the route gains one boolean field sourced from an
already-computed status. No behavior changes; no other field touched. tsc clean.

## Testing

`tests/integration/updates-status-restart-immediately-route.test.ts` (+2):
builds the router with a stub `autoUpdater` and asserts `GET /updates/status`
returns `restartImmediately` for both `true` (developer mode) and `false`
(fleet default) — covering both sides of the boundary and pinning the
regression so the field can't be dropped from the pick-list again.

## Migration parity

None — no agent-installed file changes (no hook/config/skill/CLAUDE.md template).
A read-only API field; existing agents gain it automatically on update.
