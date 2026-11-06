# Side-Effects Review — Console phone mode

**Version / slug:** `console-phone-mode`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, display only. `?phone=1` (page query, or the hash's own query) makes the console draw only the page content, for the Instar iPhone app's embedded view. Files: `dashboard/console/nav-model.js` (pure mode decision + short page names), `dashboard/console/console.js` (shell, group foot note, routing), `dashboard/console/pace.js` (two optional callbacks), `dashboard/console/console.css` (`:root[data-phone]` rules; two `56px` top-bar offsets now read `var(--topbar-h, 56px)`, same value outside phone mode), plus tests, spec, ELI16 and release note. About 150 lines across 4 runtime files. Effort: one review round, first commit attempt.

## Decision-point inventory

No decision-point surface: no gate, filter, block or allow. The only choice is how the page is drawn.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable. Known limits: content inside a page can still link to the legacy dashboard (for a legacy-only tab); the contract covers the bars, not page content. The preview address keeps its "Preview, not merged" banner in phone mode on purpose, so preview work is never mistaken for live.

## 3. Level-of-abstraction fit

Right layer: the console shell owns its bars, so the console decides whether to draw them. The decision is a pure function in `nav-model.js`, beside the other navigation model, and is unit tested.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. `phone=1` is an explicit flag from the embedding app.

## 5. Interactions

- **Shadowing:** none. Short page names resolve only in phone mode, so `#/accounts` without the flag still opens Home exactly as today (tested).
- **Double-fire:** none.
- **Races:** the 30-second page refresh compared the hash path with the rendered path; with short names those differ, so the comparison now uses the raw hash path. Without the flag the two are identical, so behaviour is unchanged. The phone Pace page swaps in its refreshed card only once it has loaded, so the refresh never blanks it.
- **Feedback loops:** none.

## 6. External surfaces

The new URL contract is consumed by the Instar iPhone app (separate repo). No server, route, state or notice changes. Sign-in (PIN, stored token, paired-phone ticket) runs before routing and is unchanged. No operator-facing actions added.

## 6b. Operator-surface quality

1. Leads with the primary action: yes, more so; the page's own content now starts at the top of the app's frame with no bar above it.
2. Zero raw internals: no new text except "Pace" and "Pace is not available on this agent right now."
3. Destructive actions: none added.
4. Plain language + phone width: phone mode is one column at every width, padding follows the safe-area insets, and fixed elements (toast, Files edit button, session composer, sticky buttons) sit above the bottom safe area instead of above a nav that is not drawn.

## 7. Multi-machine posture

Machine-local by design: a per-page-load display flag in the browser. No user-facing notices, no durable state, no generated URLs. No status surfaces changed.

## 8. Rollback cost

Pure static-asset change: revert and ship a patch. No persistent state. The app would then show the console's own bars again inside its frame until its next release stops relying on the flag.

## Conclusion

Clear to ship. The first local verify failed one floor test (`dashboard-refresh-keeps-place`: the phone Pace page drew with a raw `main.replaceChildren` instead of the `setKids` page helper that keeps the reader's place on refresh); fixed in a second commit. Review led to two adjustments: the refresh check uses the raw hash path so short names keep refreshing, and the phone Pace page swaps cards on load rather than blanking every 30 seconds.

## Second-pass review

Not required: no gate, sentinel, session lifecycle or messaging decision touched.

## Evidence pointers

`tests/unit/console-phone-mode.test.ts` (model + jsdom boot of the shipped console.js); existing `console-dom`, `console-nav-model`, `console-pace` and other console tests.
