# Side-Effects Review — Conversations Chief of Staff card dedupe, link-button layout

**Version / slug:** `conversations-cos-card-and-link-buttons`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, 5 files (~40 lines). `dashboard/console/needs-model.js` adds `chiefOfStaffCardRows(rows, { stripShown })`. `dashboard/console/chats.js` uses it so that, when the Needs-you strip (`#needsStrip`) is on screen, the Conversations page's Chief of Staff card keeps only the lease rows (`need:cos:paused`, `need:cos:expiring`, whose Check in action the strip cannot perform there) instead of repeating every project wait. `dashboard/console/console.css`: `.btn-primary` uses `min-height` + `line-height` so two-line labels fit, and `a.btn-primary` centres its label with inline-flex. Found by the 2026-11-20 live dashboard audit (topic 127504); verified by screenshots at 390x844 through a proxy serving this branch's console against the live server. One build pass, first commit attempt.

## Decision-point inventory

No decision-point surface. Which needs exist is unchanged; one surface stops repeating rows another surface on the same screen already shows.

---

## 1. Over-block

No block/allow surface — over-block not applicable. Display check: when the strip exists but fails to load, it still shows (with "Could not check"), so the card's project rows are hidden while the strip says it could not check. Every project wait is also a Needs-you row and a work-board card, so nothing becomes unreachable.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

Right layer: the selection is a pure helper beside `chiefOfStaffNeedRows`, and the page reads the DOM fact (strip present) the shell already decided (`console.js` mounts the strip only above the two front doors).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority involved.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No decision point.

---

## 5. Interactions

- `console-needs-first-screen` renders the chats page without a strip and still finds the `data-operator-need="chief-of-staff"` card with its action: passes.
- The CSS change affects every `.btn-primary`. A `<button>` already centres; `min-height` keeps the 48px floor. Rules that set the width or margin of `.btn-primary` inline buttons (`.btn-inline`) are unaffected; `a.btn-primary` padding applies only to links.

---

## 6. External surfaces

Dashboard layout only.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. On a phone the Conversations page's own content is back on the first screen, and the check-in action stays when it is needed.
2. **Zero raw internals as primary content?** Unchanged; no internals added.
3. **Destructive actions de-emphasized?** Not touched.
4. **Plain language + phone width?** Verified at 390x844: link buttons centre their label, and a two-line label stays inside the button.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Pass-through: client-side display only.

**Status surfaces:** none.

---

## 8. Rollback cost

Revert the commit.

---

## Conclusion

Two safe clutter and layout fixes.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `tests/unit/console-chief-of-staff-needs.test.ts`: `chiefOfStaffCardRows` with and without the strip, plus the chats.js wiring.
- Console unit suite 78 files / 1556 green.
- Screenshots (390x844) before: Conversations title below the fold, link button text top-left; after: title on the first screen, label centred.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
