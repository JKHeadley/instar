# Side-Effects Review — Dashboard responsive fix (.tab-panel placement + floor test)

**Version / slug:** `dashboard-responsive-fix`
**Date:** `2026-07-08`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required`

## Summary of the change

Fixes the "everything is squished to the side" dashboard bug (operator report with screenshots, topic 29723, 2026-07-08): fourteen tab panels declared after `</main>` in `dashboard/index.html` are direct `.app` grid children with no explicit grid placement, so the lone visible panel auto-places into the 280px sidebar column on desktop. The fix adds ONE shared `.tab-panel` CSS class (`grid-column: 1 / -1; min-width: 0`) applied to all fourteen panels (Integrated Being, PR Pipeline, Projects, Initiatives, Secrets, Commitments, Tokens, Resources, Blockers, LLM Activity, Routing Map, Spend, Evidence, Threadline), plus a regression floor test (`tests/unit/dashboard-panel-placement.test.ts`) that fails the build when a future after-main panel lacks a placement-carrying class. The pre-existing `.ph-root` per-tab fix is left untouched; its comment now points at the shared contract. Files touched: `dashboard/index.html`, `tests/unit/dashboard-panel-placement.test.ts`, `docs/specs/dashboard-responsive-fix.eli16.md`, this artifact, and a release fragment.

## Decision-point inventory

No decision-point surface. This change is presentation-layer CSS/HTML plus a static test. It gates no information flow, blocks no actions, filters no messages, and constrains no agent behavior at runtime. (The new unit test constrains future COMMITS — the standard test-ratchet pattern — not runtime behavior.)

---

## 1. Over-block

No block/allow surface at runtime — over-block not applicable to agent/user traffic. For the commit-time ratchet: the floor test could "over-block" a future legitimate panel that is genuinely out of normal flow (e.g. a new fixed-position overlay). Mitigation is built in: the `OUT_OF_FLOW_EXEMPT` list with a required justification comment, and the failure message names the exact panel and both resolution paths.

## 2. Under-block

The floor test keys on 4-space-indented `<div id=...>` openers in the after-`</main>` markup region (all 27 current top-level panels match this shape). A future panel authored at unconventional indentation, as a non-div element, or injected purely from JS would not be seen by the floor. Accepted: the regression vector this floor closes is the observed copy-paste pattern (14 real instances); the population-sanity assertion (≥20 openers visible) fails loudly if the matcher ever goes blind wholesale. Deeper enforcement (viewport smoke tests) belongs to the Dashboard UX Standard work tracked in the topic-29723 working brief. <!-- tracked: topic-29723 dashboard-ux-brief Increment 2 -->

## 3. Level-of-abstraction fit

Right layer. The bug is a CSS grid-placement defect; the fix is a shared CSS class at the layout layer where the sibling container classes (`files-container`, `jobs-container`, `systems-container`, `features-container`, `dropzone-container`) already solve the same problem the same way. The alternative — per-panel inline styles — is exactly the pattern that produced fourteen copies of the bug. No smarter existing gate applies (this is not decision logic).

## 4. Signal vs authority compliance

Compliant by vacuity at runtime: the change holds no blocking authority and produces no signal — it is inert presentation markup. The unit test is a build-time ratchet, the same class as every other test in `tests/unit/`; it holds commit-blocking authority through CI exactly like all tests do, with deterministic, human-readable failure output.

## 5. Interactions

- Interacts with `switchTab()` only passively: switchTab toggles inline `display`; the new class carries grid placement only, so show/hide behavior is unchanged.
- `.ph-root` panels keep their own placement + 760px prose width; the new rule does not apply to them (no double-fire; the floor test accepts either class).
- Mobile breakpoint (`@media max-width: 768px`) collapses `.app` to one column; `grid-column: 1 / -1` resolves identically there — verified byte-identical mobile rendering before vs after the change.
- No other rule targets `.tab-panel` (fresh class name; grep-verified single definition).

## 6. External surfaces

Visible change: dashboard tabs render full-width on desktop instead of squished — the operator-requested fix. No API change, no data change, no cross-agent surface, no timing/conversation-state dependency. Verified with real-browser (headless Chromium) before/after screenshots at 1280×800 and 390×844: desktop fixed; mobile rendering byte-identical to pre-change.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN in the same sense as all dashboard markup: the HTML ships identically to every machine with the release; each machine serves its own copy. No replicated state, no machine-boundary URL, no one-voice notice surface. Both of the operator's machines get the fix as they pick up the release.

## 8. Rollback cost

Trivial: revert the commit (CSS class + class attributes + one test file). No data migration, no agent state, no config. A revert restores the prior (buggy) rendering and deletes the floor test with it.
