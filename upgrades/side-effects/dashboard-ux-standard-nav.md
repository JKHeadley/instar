# Side-Effects Review — Grouped-nav reachability + Dashboard UX Standard (F1/F2)

**Version / slug:** `dashboard-ux-standard-nav`
**Date:** `2026-07-08`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required`

## Summary of the change

Makes all 25 dashboard tabs reachable (operator report, topic 29723: 17 of 25 unreachable in a clipping flat nav bar) by converting the nav into ONE grouped dropdown menu, opened from the always-visible `☰` toggle at every viewport, organized into five labeled sections. This reuses the existing (previously mobile-only) `.app.nav-open .tab-bar` collapsible-menu machinery — `toggleNavMenu`/`closeNavMenu`/`updateNavToggleLabel`/`switchTab` are untouched; every tab button's `data-tab`, `onclick`, and count badge is preserved verbatim (25 in, 25 out, cross-checked against `TAB_REGISTRY`). Ships the operator-approved `docs/specs/dashboard-ux-standard.md` (8 floors), a `docs/STANDARDS-REGISTRY.md` entry, and the F2 floor test. Files touched: `dashboard/index.html` (CSS: `.nav-toggle` visible at base + `.tab-bar` → grouped dropdown + `.tab-group`/`.tab-group-label`; markup: tabs wrapped in groups), `tests/unit/dashboard-nav-reachability.test.ts`, `docs/specs/dashboard-ux-standard.md`, `docs/STANDARDS-REGISTRY.md`, this artifact, a release fragment.

## Decision-point inventory

No runtime decision-point surface. Presentation-layer CSS/HTML plus a static test. It gates no information flow, blocks no actions, filters no messages, constrains no agent behavior at runtime. The new unit test constrains future COMMITS (the standard test-ratchet pattern), not runtime behavior.

---

## 1. Over-block

No block/allow surface at runtime. For the commit-time ratchet: the F2 floor could "over-block" a future legitimate nav change — e.g. a deliberate move to a different reachable model (persistent left rail). Mitigation: the floor asserts the FLOOR (every tab reachable, nav grouped, reachable at all widths), not a specific implementation; a left-rail that keeps tabs reachable + grouped still passes. Failure messages name the exact unreachable/orphan tab and the fix.

## 2. Under-block

The floor keys on `data-tab="..."` buttons inside the `id="tabBar"` nav and `id: '...'` entries in the `TAB_REGISTRY` array. A tab injected purely from JS (not in the static markup) or a registry authored with unconventional syntax would not be seen. Accepted: the regression vector this closes is the observed flat-nav clip (a real 25-tab overflow); the population floor (≥20 nav buttons AND ≥20 registry ids visible) fails loudly if either matcher goes blind. Deeper enforcement (the F4 viewport smoke test for body-never-h-scroll) is a tracked follow-up pass in the spec's implementation sequencing. <!-- tracked: topic-29723 dashboard-ux-brief Increment 2b -->

## 3. Level-of-abstraction fit

Right layer. The bug is nav reachability; the fix reuses the existing collapsible-menu mechanism at the layout layer rather than inventing new nav architecture (a persistent sidebar rewrite would relocate the sessions panel that owns the 280px column — higher risk for no reachability gain). No smarter existing gate applies (not decision logic).

## 4. Signal vs authority compliance

Compliant by vacuity at runtime: the change holds no blocking authority and produces no signal — inert presentation markup. The unit test is a build-time ratchet with commit-blocking authority through CI exactly like every other test, with deterministic human-readable failure output.

## 5. Interactions

- `switchTab()` already closes the menu (`classList.remove('nav-open')`) and updates the toggle label on selection — verified; the always-dropdown model needs no JS change.
- The mobile `@media` block still sets `.tab-bar` full-width (`left:0;right:0`) — it reinforces the base dropdown harmlessly (mobile menu = full width).
- `.tab-panel` placement (F1, #1403) is unaffected — this change touches only the header nav, not the after-main panels.
- Fresh class names (`.tab-group`, `.tab-group-label`) — grep-verified no prior definitions; `.nav-toggle`/`.tab-bar` rules are the only ones restyled, both verified.

## 6. External surfaces

Visible change: the dashboard nav becomes a grouped `☰` menu reachable at every width; all 25 tabs reachable (was ~8). No API change, no data change, no cross-agent surface, no timing/conversation-state dependency. Verified with real-browser (headless Chromium) at 1280×860 (grouped menu: 5 sections, all tabs, active highlight + count badges) and 390×844 (full-width menu, no h-overflow), plus the closed default state (header `☰ Sessions` button + full-width panel).

**Operator-Surface-Quality (dashboard is an operator surface):** (1) leads with the primary action — the nav is the surface's primary affordance and is now front-and-center, all destinations reachable; (2) zero raw internals — tabs are plain-language labels, grouped under plain-language section headers, no JSON/IDs/slugs; (3) no destructive action in the nav; (4) plain language a non-engineer reads ("Cost & Routing → Spend"); (5) works at phone width — 40px+ tap targets, readable 14–15px type, no horizontal scroll (headless-verified at 390px). The header-logo "broken" audit finding was confirmed a static-render false positive (logo.png served live via `express.static`) — no spurious change made.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN like all dashboard markup: the HTML ships identically to every machine with the release; each serves its own copy. No replicated state, no machine-boundary URL, no one-voice notice surface. Both operator machines get it as they pick up the release.

## 8. Rollback cost

Trivial: revert the commit (CSS + nav markup regroup + one test + the spec/registry/fragment docs). No data migration, no agent state, no config. A revert restores the prior (clipping) nav and deletes the F2 floor with it.
