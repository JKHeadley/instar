---
title: "Dashboard UX Standard — Reachable, Self-Explanatory, Responsive"
slug: "dashboard-ux-standard"
author: "echo"
status: "approved"
parent-principle: "Structure > Willpower — a quality bar that lives only in a style guide is a wish; a floor enforced in CI is a guarantee."
created: "2026-07-08"
topic: 29723
approved: "2026-07-08 (operator, topic 29723): the 8-floor bar + FD-1=grouped navigation ('Yes, please proceed as you see fit')"
decisions: "FD-1=grouped nav (operator); FD-2=viewport smoke test as a browser-gated CI job, SKIP-honest when no browser; FD-3=F7 soft-lint-first; FD-4=purpose line is the floor, inline help nice-to-have"
---

# Dashboard UX Standard — Reachable, Self-Explanatory, Responsive

## Problem statement

The operator directive (2026-07-08, topic 29723, verbatim): *"we DESPARATELY need to
improve the UI and user experience in the dashboard. At the very minimum make sure the
views/elements are properly responsive. Right now on desktop everything is squished to
the side. We should have a VERY STRONG/HIGH STANDARD for all the dashboard UI to be VERY
user friendly. All features should be VERY CLEARLY self explanatory and self contained
and EASY to navigate and use."*

The dashboard grew to **25 tabs** with no structural bar for layout, navigation, or
self-explanation. Each tab was hand-authored with inline styles; quality drifted tab by
tab because nothing enforced a floor. This standard turns the operator's bar into
**enforceable CI floors** so the quality cannot silently regress as tabs are added — the
same "structure over willpower" move that PR #1403 applied to panel placement.

## Audit evidence (2026-07-08, deployed dashboard v1.3.786)

Grounded three ways: source structure, the two live render viewports (reusing PR #1403's
headless captures), and per-panel markup inspection.

**Navigation (most severe).** At 1280px the top nav renders only ~8 of 25 tabs
(Sessions … Integrated-Being, the last already truncated) and then simply **cuts off with
no overflow affordance** — no scroll, no wrap, no "more" menu. The remaining ~17 tabs
(PR Pipeline, Projects, Initiatives, Commitments, Tokens, Resources, LLM Activity, Routing
Map, Spend, Threadline, Evidence, Process Health, Subscriptions, Preferences, Machines,
Mandates, Blockers) are **unreachable by pointer at desktop width**. In the very capture,
the *active* tab (Routing Map) is not present in the visible nav. This is the literal
opposite of "EASY to navigate."

**Responsiveness at mobile (390px).** Panel content overflows the viewport horizontally —
the description text and cards are clipped at the right edge; `document.body` scrolls
sideways. (The hamburger nav collapse itself works — the failure is panel width, not the
nav.) This is pre-existing and independent of #1403.

**Desktop layout.** PR #1403 fixed the "squished into the 280px sidebar column" bug
structurally (shared `.tab-panel` placement + a floor test). This standard **codifies**
that fix as a permanent floor rather than a one-off.

**Self-explanation.** 7 of 25 tab panels ship with **no plain-language purpose line**:
Files, Send Content (dropzone), Features, Subscriptions, Preferences, Mandates, and the
Sessions default view. A user landing on them must infer the tab's job from control labels
alone. Where descriptions DO exist they often lean on unglossed jargon ("lane", "door",
"metered", "money-gated", "must never take untrusted input").

**Assets / polish.** The header logo `<img src="/dashboard/logo.png">` renders broken
(alt "Inst" + broken-image glyph) **in the headless captures** — but this is a
STATIC-RENDER ARTIFACT, not a live defect: `logo.png` exists (601KB) and is served by
`express.static('/dashboard')` on the real server, so it resolves live; only the `file://`
scratch render (no asset serving) shows it broken. Corrected 2026-07-08 against the deployed
serving path. F8 (assets resolve) remains a valid floor, but the specific logo finding was a
false positive of the verification method.

**Root structural cause.** No shared component vocabulary. ~300 inline `font-size`/color
declarations, per-panel bespoke markup, and the placement bug all trace to the same thing:
there was no enforced contract a new tab had to satisfy.

## The bar as enforceable floors

Each floor is objective (a machine can check it) and cites the evidence that motivates it.
Floors are **additive and reversible** — they gate NEW regressions and are brought in tab
by tab; a floor never blocks an unrelated change.

- **F1 — Panel placement (SHIPPED in #1403; codified here).** Every tab panel spans the
  content column, never auto-places into the sidebar. Enforced by the existing
  `dashboard-panel-placement.test.ts`.

- **F2 — Every tab is reachable at every supported viewport (NEW, top priority).** The tab
  navigation must present a reachable affordance for *every* registered tab at ≥1280px,
  768px, and ≤390px — via horizontal scroll, wrap, a grouped/overflow menu, or a
  restructured nav. Enforced by: a static test asserting the nav container is scrollable or
  wrapping (not a fixed-width clip), plus a registry-completeness check that every
  `TAB_REGISTRY` id has a corresponding reachable nav control.

- **F3 — Every tab carries a plain-language purpose line.** The first child of every panel
  after its header is a one-sentence, jargon-glossed description of what the tab is for and
  what the user can do there. Enforced by a static test: every panel id in `TAB_REGISTRY`
  has a designated description element (shared `.tab-purpose` class).

- **F4 — The body never scrolls horizontally.** At each supported viewport, `document.body`
  has no horizontal overflow; wide content (tables, wide cards, code) scrolls inside its own
  `overflow-x:auto` container, not the page. Enforced by a viewport smoke test (see
  Enforcement).

- **F5 — Every control is labeled.** Every interactive control (button, `select`, `input`)
  has a visible text label or an `aria-label`. No icon-only or bare controls whose function
  a user must guess. Enforced by a static test over control elements in panel markup.

- **F6 — Empty / loading / error states are self-explanatory.** No panel shows a bare
  "Loading..." as its resting state or a blank area. Every data region states what will fill
  it and the action to populate it (or an honest "nothing yet, here's how"). Enforced by a
  static check that data containers declare a non-bare empty-state template.

- **F7 — Shared component vocabulary (guideline → floor).** Cards, purpose lines, stat
  tiles, and controls use shared classes, not per-tab inline styles, so one style change
  moves the whole dashboard. Ships first as a lint-warning (soft), promoted to a hard floor
  once the tabs are migrated (avoids a big-bang rewrite).

- **F8 — No broken assets.** Referenced images/icons resolve. Enforced by a static check
  that asset references have a real target (or are inlined).

- **F9 — A background refresh never clobbers an open interaction (added 2026-07-10, topic
  29836 case study).** Any dashboard surface that polls/re-renders MUST NOT replace an
  element holding an open interaction: an in-progress multi-step episode (marked
  `data-interaction-open`), a focused text-entry element, or a dirty (partially-typed)
  field. While an interaction is open the poll MERGES server state into the view
  (targeted patches — e.g. live countdowns via `data-ttl-expires`) instead of rebuilding
  the interacting DOM; the hold releases when the flow reaches a terminal state
  (verified / failed / cancelled / expired) or the user backs out. Evidence: the
  Subscriptions matrix "Set up" flow reverted the PIN input to a button mid-typing and
  swapped the code-paste step for "◷ Signing in…" before the code could be pasted
  (screenshot-proven, 2026-07-10). Shared primitives: `hasOpenInteraction` +
  `updateCountdowns` in `dashboard/subscriptions.js`. Enforced by
  `tests/unit/dashboard-refresh-interaction-hold.test.ts` (semantics + a negative
  control proving a naive rebuild WOULD clobber) and the Subscriptions controller
  integration tests (a poll mid-interaction leaves the typed state intact). Migrating
  the other polling tabs (mandates, process-health, preferences) onto the shared
  primitives — and promoting F9 to a static lint over `dashboard/*.js` — is a tracked
  follow-up <!-- tracked: topic-29836 --> ; until then F9 is a hard floor for the
  Subscriptions tab and the rule of record for every NEW polling surface.

## Enforcement design

Two tiers, mirroring the money-increment "static floor + smoke test" pattern:

1. **Static floors (F1, F2-registry, F3, F5, F6, F7, F8)** — pure parse/grep tests over
   `dashboard/index.html`, no browser. Fast, deterministic, run in the normal unit shard.
   They extend the exact pattern PR #1403 proved (`dashboard-panel-placement.test.ts`): a
   negative-control proves the test actually fails when the floor is violated, and a
   population floor prevents the test going silently blind if the registry parsing breaks.

2. **Viewport smoke test (F2-reachability, F4)** — the one piece that needs a real render:
   load the dashboard at 1280 / 768 / 390 px in headless Chromium (the harness already used
   for #1403 verification), assert (a) every registered tab is clickable/reachable and (b)
   `document.body.scrollWidth <= clientWidth` at each width. Gated behind a CI job that has a
   browser; if the browser is unavailable the job reports SKIPPED-honestly rather than
   passing blind. **Open decision for the operator (FD-2): run this smoke test in CI on every
   PR (needs a browser in CI) or as a pre-merge manual gate?**

3. **Constitution registry** — add "Dashboard UX Standard" to `docs/STANDARDS-REGISTRY.md`
   with its enforcing guards named, so the Standards-Enforcement-Coverage audit tracks it
   and flags if a guard ever goes missing (dangling-ref detection).

## Implementation sequencing (Increment 2b, after this is approved)

The standard is approved first (defines the bar); then the improvement pass applies it. To
avoid a 9,600-line-file big-bang and keep each step reviewable:

1. **Nav reachability (F2)** — highest user impact; make all 25 tabs reachable at every
   width (recommend: grouped nav or an overflow "More" menu — see FD-1). Land F1+F2 floors.
2. **Purpose lines + labels + empty states (F3, F5, F6)** — a pass adding the missing 7
   purpose lines, auditing controls, and fixing bare empty states. Land those floors.
3. **Mobile width (F4)** — constrain panels to the viewport; land the smoke test.
4. **Shared vocabulary (F7) + assets (F8)** — extract shared classes, fix the logo.

Each step is its own PR with browser-verified before/after screenshots at all three widths.

## Frontloaded decisions (operator input)

- **FD-1 — Nav model for 25 tabs.** Options: (a) grouped sidebar with sections
  (Sessions/Work/Money/Machines/…), (b) a horizontal scroll strip, (c) a "More ▾" overflow
  menu after the top N. Recommendation: **(a) grouped** — 25 flat tabs is too many to scan
  even if reachable; grouping also serves "EASY to navigate." Needs the operator's taste.
- **FD-2 — Viewport smoke test placement.** CI-on-every-PR (needs a browser in the CI image)
  vs a pre-merge manual gate. Recommendation: CI, if a browser is already available;
  otherwise start as a documented manual gate and add CI when the image supports it.
- **FD-3 — F7 timing.** Soft lint now / hard floor after migration (recommended) vs hard
  floor immediately (bigger up-front rewrite).
- **FD-4 — Scope of "self-contained."** Does every tab need an inline help/"?" affordance, or
  is a strong purpose line sufficient? Recommendation: purpose line is the floor; an inline
  help affordance is a nice-to-have, not a gate.

## Non-goals

- A visual redesign / re-theme (colors, brand). This standard is about reachability,
  clarity, and responsiveness — not a new look.
- Changing what any tab DOES. Behavior is untouched; only its presentation and reachability.
