# Side-Effects Review — Development page shows when auto-merge is stopped

**Version / slug:** `console-development-stopped-lead`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1: 4 source and test files, about 250 lines, most of them tests; one review round, one commit attempt expected. `dashboard/console/development-model.js` gains `stoppedLead` and `foldFromHash`, says stopped in `Shipping.line` and tone, and makes the headline lead with the stop. `dashboard/console/development.js` renders the lead card above other leads, moves the fold's button above the list, shares one `backOnButton` calling the unchanged `enableAutoMerge`, applies `?s=` once per arrival, and scrolls once per arrival. `dashboard/console/ui.js` flattens nested kids at any depth in `el` and `setKids`, the source of the "[object HTMLParagraphElement]" text.

## Decision-point inventory

No decision-point surface. `shipping.stopped` already existed and is only read for display. The re-arm still goes through the server's PIN gate on `/green-pr-automerge/enable`; its request body is unchanged and pinned by a test.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface. As a signal: if the watcher read fails the page cannot know, so there is no card; the Shipping bar and tiles say "can't tell" as before, never a calm "not stopped". An unknown `?s=` value names no section and leaves the remembered one alone (it used to leave every fold shut).

## 3. Level-of-abstraction fit

The decision lives in the view-model as this page's rule requires, and the card only renders it. The stringify fix is in the shared builder rather than at the one `feedbackBody` call site, because any page can nest a mapped list in the same way; the change only affects arrays that would otherwise be stringified.

## 4. Signal vs authority compliance

Reference: `docs/signal-vs-authority.md`. This is display only and holds no blocking authority. The server remains the only authority on re-arming.

## 5. Interactions

- PR 2678 (agent-stop-release) adds a wording branch inside `watcherLine` and test lines in another `describe`. The card shows `watcher.text` as its "who stopped it" line, so 2678's wording reaches the card with no further change. A trial merge of the two is clean.
- The 30-second refresh calls `renderDevelopment` on the same `<main>`, so `.dev-page` exists and `?s=` is not reapplied. Every route change builds a new `<main>`, which is the arrival signal.
- Scrolling on every repaint when the address held `?s=` is gone; it would have pulled the page back on refresh or fold tap.
- `developmentHeadline` now counts the stop as one thing needing the operator, and adds Shipping's needs-you rows the same way it did before.

## 6. External surfaces

Maintainer-only console page text and layout. No API, message or route changes. The card's button is the same action as the existing one.

## 7. Multi-machine posture

Machine-local by design, as the page already was: it reads the local `/green-pr-automerge`. A standby machine shows what its own read says.

## 8. Rollback cost

Revert the commit and release. Browser-side files only, with no state, config or migration.

## Evidence pointers

`tests/unit/console-development.test.ts`: four new tests fail on the old page code and pass on the new. Browser proof at 1280 wide, stopped and not stopped, through a proxy that refused every write; the live latch was not touched and no PIN was used.
