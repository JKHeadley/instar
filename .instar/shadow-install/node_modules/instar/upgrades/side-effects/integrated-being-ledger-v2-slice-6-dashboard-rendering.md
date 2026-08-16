# Side-Effects Review — Integrated-Being Ledger v2, Slice 6 (Dashboard rendering)

**Version / slug:** `integrated-being-ledger-v2-slice-6-dashboard-rendering`
**Date:** `2026-04-17`
**Author:** Echo
**Second-pass reviewer:** not required — client-side rendering change; no block/allow surface, no auth surface, no session lifecycle.

## Summary

Slice 6 enhances the existing `Integrated-Being` dashboard tab to render v2 commitment-kind entries with their mechanism/deadline/status context visible. Slice 6 is read-only dashboard work — resolution buttons + sessions-subtab land in slice 7 together with the user-resolve PIN-unlock path.

What a user now sees on the dashboard:

- **Commitment rows** carry badges for the mechanism type (color-coded: `passive-wait` gets an amber "weakest mechanism" color, others blue), refStatus if not-valid, and a derived effective-status label (`expired`, `stranded`, `resolved`, `cancelled`) computed from the supersession chain in the same result set.
- **Deadlines** render on their commitment row with an overdue highlight (red) if deadline < now.
- **Dispute counts** show inline on commitment rows when at least one dispute-note points at them.
- **Observation notes** (`expired:`, `stranded:`, dispute-note) get their own kind badges so users can scan the stream and see lifecycle events.

This is read-side slice 6. Slice 7 will add actionable controls (resolve/cancel/dispute buttons, session revocation subtab).

Files touched:

- `dashboard/index.html` — the `loadIntegratedBeing()` render body (~90 LOC of JS)

## Decision-point inventory

None. This slice introduces no new gates, authorities, or filters. All logic is rendering of already-authoritative server data.

## 1. Over-block

No block/allow surface. Rendering presents data; it does not decide.

## 2. Under-block

No block/allow surface. But a rendering-correctness question: the effective-status derivation (e.g., "this commitment is expired") is computed CLIENT-side from a single page of entries (default 50). If the superseding `expired:` note is outside the returned page but the commitment is inside it, the UI will show the commitment as `open`. This is acceptable because:

- The server-side render path (`/shared-state/render`) uses its own depth walk and is authoritative for prose injection;
- Increasing the page limit (up to 200) usually covers the lag;
- Dashboard is an observability surface, not a security boundary.

## 3. Level-of-abstraction fit

Rendering lives in the dashboard HTML where other rendering lives. Server returns raw entries (existing `/shared-state/recent`); client renders. Correct layer — rendering is NOT promoted to the backend because different surfaces may want different rendering (prose injection vs tabular, etc.).

## 4. Signal vs authority compliance

Not applicable — no decision surface introduced.

## 5. Interactions

- **Shadowing:** existing dashboard behaviors (summary cards, filter dropdowns, chain explorer, paginated polling) are untouched. The entry-rendering loop body is the only thing that changes.
- **Double-fire:** the 30s poll cadence is unchanged; no new timers.
- **Races:** none. Pure render of already-received JSON.
- **Feedback loops:** none.

## 6. External surfaces

- Dashboard users see new badges on commitments + observation notes. v1 users who don't have v2Enabled see no change (commitment entries are scarce pre-v2 and the badges render gracefully when fields are missing).
- No API shape changes.

## 7. Rollback cost

- Pure code revert of the HTML file. Dashboard falls back to the original plain-table rendering. No data implications.

## Conclusion

Small, read-only, low-risk. Slice 7 will layer the interactive controls on top.
