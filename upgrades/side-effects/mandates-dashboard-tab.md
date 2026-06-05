# Side-effects review — Mandates dashboard tab + coordination awareness backfill

Spec: `docs/specs/coordination-mandate.md` (approved A/A/B; decision 2A makes the
dashboard-behind-PIN the issuance surface). Change: a new dashboard **Mandates** tab
(`dashboard/mandates.js` external module + index.html shim) + the Migration-Parity
CLAUDE.md backfill for the three coordination surfaces shipped in #788/#797/#799.

## 1. Blast radius

- **Dashboard:** additive — one new tab button, panel, TAB_REGISTRY entry, lazy
  module import (the process-health.js pattern), and scoped `.mnd-*` CSS. No existing
  tab, function, or style is modified. The dashboard ships inside the npm package, so
  existing agents receive the tab on their next update with no migration.
- **PostUpdateMigrator:** three new content-sniffed CLAUDE.md backfill blocks
  (Coordination Mandate / ReviewExchange / Cutover Readiness), appended only when the
  distinctive route marker is absent — idempotent, never rewrites existing content.
  This closes a REAL parity gap: #788/#797/#799 added the template blurbs for new
  agents but no backfill, so the deployed fleet would never have learned these
  surfaces exist.
- **templates.ts:** one line sharpened (point the operator at the "Mandates tab"
  rather than the generic dashboard).

## 2. Security model (the PIN discipline, in the UI this time)

- The tab's issue/revoke forms collect the PIN in a `type="password"` input with
  `autocomplete="off"`, send it ONCE in the request body to the already-PIN-gated
  routes, and **clear the field immediately after the response — success or failure**.
  It is never written to localStorage, module state, or logs (behaviorally tested).
- The Bearer token the dashboard holds cannot issue/revoke — that is the engine's
  server-side design (#788); this tab is just the human surface decision 2A names.
- Rendering is XSS-safe: every dynamic field (ids, scopes, fingerprints, authority
  bounds, audit reasons — all potentially attacker-influenced via the API) is escaped
  (tested with hostile payloads).
- A broken audit chain (`chain.ok:false`) renders as a loud "CHAIN BROKEN — possible
  tampering" badge, never silently.

## 3. State / data

None on the server. The tab reads `/mandate` + `/mandate/audit` and writes only
through the existing PIN-gated routes. Browser-side, nothing persists beyond the
already-stored dashboard Bearer token (unchanged).

## 4. Failure modes

- Older server without the engine → 503 → friendly "engine unavailable" copy.
- Module load failure → console error, tab simply shows nothing (no crash).
- Wrong PIN → the route's 403 + attempt limiting surface as an inline error; the
  field still clears.

## 5. Test coverage

18 tests: 5 HTML-at-rest wiring (tab/panel/registry/lazy-import/plain-language), 4
renderer (deny-by-default copy, badges, XSS with hostile payloads, broken-chain), 6
controller (PIN required → no request; PIN sent once then CLEARED on success AND on
403; template prefill; 503 state), 4 migration (backfill lands with port baked in,
security copy verbatim, idempotent, no double-patch on fresh agents).
