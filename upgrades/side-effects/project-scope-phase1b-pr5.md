# Side-Effects Review — project-scope Phase 1b PR 5 (Dashboard Projects tab + Initiatives filter)

**Version / slug:** `project-scope-phase1b-pr5`
**Date:** `2026-05-11`
**Author:** `echo`
**Second-pass reviewer:** `required (new dashboard surface + new server-side filter)`

## Summary of the change

Fifth PR of project-scope Phase 1b. Ships the dashboard surface plus
the small server-side filter the dashboard depends on. The compaction-
recovery hook's active-projects digest was already in the template (it
shipped alongside session-start.sh in Phase 1.9 / PR 1's session-start
work and the equivalent block is present at lines 467-509 of
`src/templates/hooks/compaction-recovery.sh`), so no template change
is needed for this PR.

Spec source: `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.10
("Dashboard Projects tab"), § Phase 1.10 ("Initiatives tab filter").

Modified files:
- `dashboard/index.html` (+~210 lines) — adds the Projects tab button
  alongside the Initiatives tab, adds the Projects panel HTML (header,
  empty state, list container), registers the tab in the panel router,
  and ships ~180 lines of JS:
  - `loadProjects()` — fetches `/projects`, filters to `status:'active'`
    client-side, fetches each project's joined view via
    `/projects/:id?reconcile=false` in parallel (capped at 25), renders
    cards.
  - `renderProjectCard(project, children)` — XSS-safe construction
    (`textContent` everywhere, `appendChild` only, no `innerHTML`).
    Per spec: title row, drift status badge (colored per verdict),
    round-by-round progress bar + pipelineStage histogram + Halt
    + Ack buttons.
  - `startProjectsPoll` / `stopProjectsPoll` — 15-second `setInterval`
    when the tab is active, cleared on deactivation.
  - `projectHalt(id)` + `projectAck(id, idx)` — POST to the new
    runner-backed routes. 409 ("version mismatch") triggers a silent
    `loadProjects()` re-render rather than an error toast.
  - `loadInitiatives()` is updated to pass
    `?excludeKind=project&excludeParented=true` by default, with a
    "Show projects + children" checkbox to bypass. The filter is
    server-side; the records never make the wire-trip.
- `src/server/routes.ts` (+~10 lines) — `GET /initiatives` now accepts
  `excludeKind=<string>` (drops records where `kind ?? 'task'` matches)
  and `excludeParented=true` (drops records with a `parentProjectId`).
- `tests/unit/routes-initiatives.test.ts` (+3 cases + mirror update) —
  exercises both new params individually and combined with the existing
  `status=` filter. The test mirror at the top of the file (which
  duplicates the production handler shape) was updated in lockstep.

## Decision-point inventory

- **Initiatives filter** — **add** — `excludeKind` and
  `excludeParented` are additive query parameters that DEFAULT TO NOT
  EXCLUDING. Existing callers see no behavior change. The dashboard
  opts in via a UI checkbox that defaults to "exclude" (matches the
  spec's "filter project-kind by default").
- **Projects tab read-only verbs** — **add** — the Halt and Ack
  buttons route through the existing `POST /projects/:id/halt` and
  `POST /projects/:id/ack` (shipped in PR 3). No new HTTP surface in
  this PR. The buttons act on the project record's current version
  (from the latest `loadProjects()` fetch); the routes enforce OCC
  via `If-Match` — actually, `/halt` and `/ack` do NOT require
  `If-Match` in PR 3's design (they use the tracker's internal
  version-aware update via `ifMatch` from the latest `get()`). The
  dashboard relies on that internal handling rather than passing
  `If-Match` itself.
- **15-second poll cadence** — **add** — matches the spec exactly.
  The interval is cleared when the tab deactivates so a hidden tab
  doesn't burn cycles.

## Over-block vs under-block analysis

### Server-side filter
Over-block: the dashboard's default-on filter means a user who clicks
"Initiatives" no longer sees project-kind records or child items
unless they tick the "Show projects + children" checkbox. This is the
spec's documented behavior (Projects get their own tab; children live
inside their parent's card). No information is lost, just relocated.

Under-block: the filter is purely additive. Existing scripts or
clients that hit `/initiatives` without the new params see the same
behavior they always have.

### Dashboard rendering
Over-block: 409 from `/halt` or `/ack` is treated as "stale view,
just refresh" — no error toast, no user-visible noise. The spec
explicitly calls this out: "409 response handled silently: refresh
+ re-render, no error toast."

Under-block: the project-list fetch caps detailed lookups at 25. A
deployment with >25 active projects would have the rest rendered as
empty cards (since `detailed` is `null` for un-fetched IDs and we
skip nulls). Acceptable for Phase 1; a follow-up PR can add pagination
when project count actually exceeds the cap.

### XSS safety
Every rendered string goes through `.textContent` (never `.innerHTML`).
Project ids, titles, round names, child stages, drift verdicts — all
constructed via `createElement` + `textContent` + `appendChild`. The
existing `dashboard/index.html` conventions already enforce this; the
new code follows the same pattern.

## Signal vs authority audit

Dashboard is **read-only display** for the project surface (with two
button-triggered mutating calls to existing PR 3 routes). The
authority for halt and ack lives in `ProjectRoundRunner` — the
dashboard just calls the documented endpoints. No new authority
introduced.

The initiatives filter is a **read-side** filter, not a
record-modifying gate. The records themselves are unchanged; the
filter only affects the response set.

## Interactions with existing systems

- **PR Pipeline tab.** No interaction — the Projects tab uses its
  own panel + JS namespace.
- **Initiatives tab.** Shares the existing `loadInitiatives()`
  function; the new filter is a query-string addition with a UI
  checkbox to bypass. Existing tab behavior preserved when the
  checkbox is checked.
- **`/projects/:id?reconcile=false`.** This query parameter is
  already documented in the spec (Phase 1.3 — "Clients that need
  pure-read semantics use `?reconcile=false`"). The dashboard uses
  it to avoid triggering the lazy reconciler on every 15-second
  poll. The `?reconcile=false` parameter is honored as a passthrough
  in the existing route (the lazy reconciler isn't wired yet, so
  it's a no-op today — when the reconciler ships, the dashboard
  poll won't trigger it).
- **Compaction-recovery hook.** Already includes the active-projects
  digest section (PR 1's template work). No change needed in this PR.

## Rollback cost

Revert removes the new tab button, the new panel HTML, the JS block,
the Initiatives filter checkbox, the server-side filter, and the test
cases. No schema changes. Existing project records and initiatives
are unaffected.

## Verification

- `npm run lint` — passes (tsc + lint-no-direct-destructive).
- `npx vitest run tests/unit/routes-initiatives.test.ts
  tests/unit/route-completeness.test.ts
  tests/integration/projects-api.test.ts
  tests/unit/dashboard-initiativesTab.test.ts` — 66/66 pass.
- Existing PR 1-4 invariants still green.
