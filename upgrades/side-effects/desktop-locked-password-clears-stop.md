# Side-Effects Review — the locked-Mac password box no longer covers Stop

**Version / slug:** `desktop-locked-password-clears-stop`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`dashboard/desktop.css`: `#lockedPassword` and `#lockedPasswordReason` change `top` from `max(.5rem, env(safe-area-inset-top))` to `calc(max(.35rem, env(safe-area-inset-top)) + 2.9rem)`, so they start below `.desktop-bar` (which holds Stop) instead of over it. Plus one unit test. Tier 1: 2 files of product/test change (about 50 lines including the test), one CSS property on two rules; a revert fully undoes it. Effort: no spec rounds; one commit attempt so far.

## Decision-point inventory

None. Layout only; no gate, filter, or decision logic.

## 1. Over-block

No issue identified. Nothing is rejected; the box only moves down by about 2.75rem.

## 2. Under-block

The unit test pins a fixed offset (at least 2.5rem). If `.desktop-bar` grows taller later (a second line, larger type), the box could overlap it again without the test failing. The headless hit-test used as evidence here is not part of the suite.

## 3. Level-of-abstraction fit

Right layer: the overlap is a stylesheet fault, fixed in the stylesheet. Raising `.desktop-bar` above the box instead was considered and rejected: the bar spans the full width with a gradient, so it would sit over the top of the box's label.

## 4. Signal vs authority compliance

Not a decision point; holds no authority.

## 4b. Judgment-point check

No heuristic added — not applicable.

## 5. Interactions

`#leaveUnlockedButton` is anchored to the bottom and is unaffected. `#keyboardBar` is at the bottom (z-index 7) and is unaffected. The box keeps its z-index (8) over the screen image, so it still sits above the live desktop. The locked-screen proof driver clicks `#stopButton` and fills `#lockedPasswordInput` by id, which is unaffected by position.

## 6. External surfaces

Visible to anyone using the remote desktop page while a Mac is locked: the password box starts about 44 px lower. No API, data, or other-agent change.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes. The password box is still the first block under the top bar, with the field and Unlock button visible on arrival at both 1280x728 and 390x844.
2. **Zero raw internals as primary content?** Yes. Unchanged wording; no identifiers shown.
3. **Destructive actions de-emphasized?** Stop stays a small button in the top bar's right corner, as before; this change makes it reachable, not more prominent.
4. **Plain language + phone width?** Verified at 390x844: the box spans the width inside the safe-area margins, starts at 52 px, and Stop's centre hit-tests to Stop. Screenshots before and after at both sizes were taken from a headless Chrome render of `dashboard/desktop.html` in its live layout.

## 7. Multi-machine posture

Machine-local BY DESIGN: a static stylesheet served by whichever machine serves the page; no state.

## 8. Rollback cost

A plain revert. No data, config, or migration.

## Conclusion

Safe to ship as Tier 1. It fixes a fault where a person could not press Stop while the password box showed.

## Second-pass review (if required)

Not required: no gate, sentinel, session lifecycle, or messaging decision.

## Evidence pointers

Live failure: locked-screen proof case 12.5a, 2026-11-05 18:32 PST, `page.click('#stopButton')` timed out with "<form id="lockedPassword">…</form> intercepts pointer events". Headless hit-test: main → `lockedPassword` at both sizes; this change → `stopButton` at both sizes. `tests/unit/desktop-locked-password-clears-stop.test.ts`: fails on main's stylesheet, passes on this one.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
