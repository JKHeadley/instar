# Dashboard — desktop layout fix: tabs no longer squished into the sidebar column

**ELI16:** `docs/specs/dashboard-responsive-fix.eli16.md` (Tier 1 — small presentation-layer fix, operator-requested)
**Side-effects:** `upgrades/side-effects/dashboard-responsive-fix.md`
**Maturity:** Stable — pure bug fix, no flag, visible immediately.

## What Changed

- **The "squished to the side" bug is fixed structurally.** Fourteen dashboard tab panels
  (Routing Map, Spend, Tokens, LLM Activity, Integrated Being, PR Pipeline, Projects,
  Initiatives, Secrets, Commitments, Resources, Blockers, Evidence, Threadline) are declared
  after `</main>` and are therefore direct `.app` grid children; with the sidebar hidden they
  auto-placed into the 280px sidebar COLUMN, rendering all content in a ~185px strip on a
  1280px viewport (operator screenshots, topic 29723). A shared `.tab-panel` class
  (`grid-column: 1 / -1; min-width: 0`) now places every one of them across the full content
  area — one rule instead of fourteen inline copies. The pre-existing `.ph-root` tabs keep
  their own placement + prose width.
- **A placement floor makes the bug unrepeatable.** `tests/unit/dashboard-panel-placement.test.ts`
  scans the after-main markup region and fails the build when a top-level panel lacks a
  placement-carrying class (with an instructive message naming the panel and the fix), asserts
  the `.tab-panel` rule keeps its grid span, and guards its own matcher with a population floor.
  The old defense was a CSS comment on `.ph-root` — a wish; every panel added since repeated
  the bug. This is the guarantee (Structure > Willpower).

## Evidence

`tests/unit/dashboard-panel-placement.test.ts` — 4 cases: rule present + spans grid, every
placement class actually declares grid-column, no bare after-main panel (negative control
verified: stripping one panel's class fails naming exactly that panel), matcher-anchor guard
(the slice skips CSS/JS mentions of `</main>`). Real-browser (headless Chromium) before/after
screenshots at 1280×800: content strip ~260px before, full-width after; 390×844 rendering is
byte-identical before vs after (placement-only change). All 106 dashboard-reading unit tests green.

## What to Tell Your User

The dashboard tabs that used to render squeezed into a narrow strip on the left of a desktop
window — including the new Routing Map and Spend tabs — now use the full width of the window.
Nothing to enable; it's just fixed everywhere once the release lands.

## Summary of New Capabilities

- None — this is a layout bug fix. (It also adds a build-time guard so a future dashboard tab
  can't reintroduce the same squished layout.)
