# Side-Effects Review — Dashboard health-signal polish (3 pre-existing fixes)

**Version / slug:** `dashboard-health-signal-polish`
**Date:** `2026-06-23`
**Author:** Echo (autonomous)
**Tier:** 1 (three contained, low-risk fixes — two client-side dashboard guards + one health-status windowing on an endpoint whose `status` field does not gate restarts on this agent)
**Second-pass reviewer:** not-required (Tier 1; small contained fixes, the server-side change covered by new unit tests)

## Summary of the change

Three minor, pre-existing dashboard issues found while verifying the dashboard-freeze fix (#1253). None affect the dashboard connection; all are noise/cosmetic.

1. **WhatsApp QR poll spam.** `pollWaQr()` polls `/whatsapp/qr` every 3s. When WhatsApp isn't configured the route returns 503, but the poll loop was never stopped — so the browser console accumulated ~20 503s/min for the whole session. Fix: call `stopWaPolling()` on the 503 (adapter absent).
2. **Null-deref TypeError on load.** A parse-time block attached a `'message'` listener to `ws`, guarded by `if (typeof ws !== 'undefined')`. `ws` is a declared `let` that is **null** at parse time (`connectWebSocket()` runs later in a `.then()`), and `typeof null === 'object' !== 'undefined'`, so the guard passed and `ws.onmessage` threw `Cannot read properties of null (reading 'onmessage')` on every load. The block was the only place paste WebSocket events refreshed the drop-zone — so the feature was also effectively dead. Fix: fold `paste_delivered` / `paste_acknowledged` into the main `handleMessage` switch (where it survives reconnects) and remove the broken parse-time block.
3. **Stale "Degraded" badge.** The vital-signs badge renders `/health`'s `status`, which is `degraded` whenever `DegradationReporter.getEvents().length > 0`. Degradation events are append-only and never self-clear, so a single transient/benign fallback pins the badge red for the entire process lifetime even after recovery. Fix: `/health` now uses a new `DegradationReporter.getRecentEvents()` (30-min window) for status + the reported count/summary — a persistent problem keeps re-reporting so it stays visible; a one-off ages out.

## The change

- `dashboard/index.html` — (1) `stopWaPolling()` on 503; (2) paste cases added to `handleMessage`, broken parse-time block removed.
- `src/monitoring/DegradationReporter.ts` — new `getRecentEvents(windowMs = HEALTH_WINDOW_MS, now = Date.now())` + `static HEALTH_WINDOW_MS = 30min`. Filters by event `timestamp`; an unparseable timestamp is KEPT (fail-safe: surface, never hide). `getEvents()` (full log) is unchanged.
- `src/server/routes.ts` — `/health` calls `getRecentEvents()` instead of `getEvents()` for the `degradations` list that feeds `status` + `degradations` count + `degradationSummary`.
- `tests/unit/degradation-reporter.test.ts` — 3 new tests (recent kept / old aged out / unparseable kept).

## Side effects & risk

- **`/health` status semantics.** `status` flips back to `ok` once degradations age past 30 min without recurring. Reviewed consumers: the **Telegram lifeline** derives `serverHealthy` from the supervisor's process status, NOT from `/health.status`, so this never affects restart behavior on a Telegram agent (Echo). `SlackLifeline` keys on `status === 'ok'` only to detect the unhealthy→healthy *recovery* transition (a log/notify), not to trigger restarts. The change makes status MORE truthful (reflects current health), and is the safe direction (a real, recurring problem keeps re-reporting and stays visible).
- **The full degradation log is untouched.** `getEvents()`, `getUnreportedEvents()`, mark-reported, and persistence all still see every event — only the /health *status view* is windowed.
- **Client-side fixes are isolated** to the dashboard static asset; no server behavior changes; the dashboard isn't in the typecheck/test suite, so both were syntax-checked with `node --check`.
- **Risk:** low. No new config, no new route, no migration (the dashboard asset + core source ship with the package on update). Reversible (revert the three edits).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

This change touches `dashboard/index.html`. It alters **background behavior**, not layout or primary actions — so it adds no new operator-facing controls or content. Against the four criteria:

1. **Leads with the primary action?** Unchanged — the dashboard still leads with the session list + vital-signs strip. No new primary action is introduced; nothing is moved, collapsed, or pushed below the fold.
2. **Zero raw internals as primary content?** Yes — the change adds NO displayed content. It REMOVES noise (the WhatsApp console 503 spam) and an on-load TypeError, and makes the existing plain-language health badge ("Healthy" / uptime vs "Degraded") accurate. No JSON/UUID/fingerprint/hash is shown.
3. **Destructive actions de-emphasized?** N/A — no destructive control is added or touched.
4. **Plain language + phone width?** Yes — the only user-visible behavioral change is the top-of-dashboard badge now correctly reads "Healthy" when the box is healthy (it was stuck on "Degraded"). Plain wording, same layout, same width — no new elements, so no phone-width regression.

(The dashboard's pre-existing raw-input field — the PIN/token unlock — already carries the co-located `operator-surface-power-user` marker and is untouched here.)

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The vital-signs badge reads THIS machine's `/health`; each machine's `DegradationReporter` and health state are local, per-machine observability (a degradation on machine A is machine A's concern). The dashboard already exposes pool-wide state through separate `?scope=pool` surfaces (sessions, guards, attention, …), which this change does not touch. The WhatsApp poll and the paste WS handler are pure client-side, per-browser-tab.

- **User-facing notices?** None emitted — no one-voice gating concern.
- **Durable state strand on topic transfer?** No durable state added; nothing strands.
- **Generated URLs?** None.

## Verification

- `tsc --noEmit`: 0 errors.
- `tests/unit/degradation-reporter.test.ts`: 20/20 (incl. 3 new windowing tests).
- `tests/unit/{routes-degradations-mark-reported,degradation-never-silent,degradation-reporter-reentrancy-wedge}.test.ts`: 14/14 (no regression on the mark-reported / never-silent paths).
- `dashboard/index.html` embedded script: `node --check` passes.

## Rollout

No flag, no migration. Three additive fixes that surface previously-hidden console errors and make the health badge truthful. The genuinely-stale `systemReview` *panel* (last ran 2026-06-20, never re-runs) is a SEPARATE, more-involved concern (re-running 16 probes on a cadence is cost-bearing) — explicitly NOT bundled here; tracked for follow-up.
