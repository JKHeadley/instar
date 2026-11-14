# Side-Effects Review — A dashboard refresh keeps the operator's place

**Version / slug:** `console-refresh-keeps-place`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1: browser-only files, 20 existing files plus a new test, half of it tests; one review round. `dashboard/console/ui.js` gains the place-keeping in `setKids`, plus `firstPaint`, `arrivalScroll`, `newArrival` and `refreshHeld`. `console.js` route() opens an arrival and holds or serializes the refresh tick. Fourteen pages swap their skeleton guard for `firstPaint`, and seven swap a raw scroll for `arrivalScroll`. `ideas.js` and `maturation-board.js` stop bypassing `setKids`. Legacy `index.html` keeps Integrated-Being rows on a missed read. A first version restored every fold and undid tab taps on Development; the existing Development test caught it, and now only folds the operator moved away from how the page drew them are restored.

## Decision-point inventory

One small decision: `refreshHeld` skips a background repaint while a focused or typed field, an `data-interaction-open` marker, or selected text exists on the page. It constrains only the page's own repaint, not information flow, and the next tick tries again.

---

## 1. Over-block

A field holding typed text that the operator walked away from holds that page's refresh until it is cleared or they navigate. The page then shows older numbers, with no indicator. Accepted: F9 already chooses keeping typed text over fresh data, and a pre-filled field (value equal to its default) does not hold. Selected text holds the same way.

## 2. Under-block

A fold whose wording changes beyond numbers loses its match and returns to its default. A page that shrinks for real still moves the viewport (Home moved 1158 to 1119 when a row above went away), which is correct. A failed read on a page still replaces content with its "can't tell" line, without a jump above what the shorter page allows.

## 3. Level-of-abstraction fit

It belongs in `setKids`, the one call nearly every page already uses to fill `<main>`, so pages need no state of their own. Only `<main>` carries the place; nested repaints are plain replaces so a sub-part does not fight its page.

## 4. Signal vs authority compliance

Reference: `docs/signal-vs-authority.md`. Display behavior only, with no authority over messages, sessions or actions. The floor test is a CI check on source and rendered pages.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point. `refreshHeld` is an F9 floor over directly observed DOM state, not a judgment between live signals.

## 5. Interactions

- PR 2680 edits the same Development lines and drops the repeated scroll; this PR is rebased on it after it lands and replaces that site with `arrivalScroll`. Its `foldFromHash` stays.
- A restored `button[aria-expanded]` fold is re-opened through its own click handler, so page state and lazy reads stay right. A lazy fold re-reads on each repaint, which is what an open fold on a refreshed page should do.
- The Sessions and Files pages keep their own early returns and only repaint their list halves, so they are unaffected.
- The shared Maturation view also runs on the standalone page, whose `<main>` is covered the same way.

## 6. External surfaces

Console and legacy dashboard behavior only. No route, message, config or stored state changes.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Unchanged order; this keeps the operator where they are and never scrolls them away from an action. The first-screen rule is the next PR.
2. **Zero raw internals as primary content?** No content changes.
3. **Destructive actions de-emphasized?** No control changes.
4. **Plain language + phone width?** No wording changes. The refresh was run at 390x844 on Permission slips and held position.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: per-browser view state in page memory. Nothing to replicate.

## 8. Rollback cost

Revert the commit and release. Browser files only, with no state or migration.

## Conclusion

Clear to ship. The riskiest part, fold restore fighting page-owned state, was found by an existing test and is pinned by a new one.

## Second-pass review (if required)

Not required: no messaging, session lifecycle, gate or sentinel surface.

## Evidence pointers

`tests/unit/dashboard-refresh-keeps-place.test.ts` with a mutation check (a raw skeleton and a raw scroll each fail it). Browser before and after numbers are in `upgrades/next/console-refresh-keeps-place.md`. The dashboard PIN was never read or used; the browser used the agent's bearer token.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
