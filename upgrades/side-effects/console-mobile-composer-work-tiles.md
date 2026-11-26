# Side-effects review: phone message box stays above the bottom bar; merged tiles removed

## Change
1. `dashboard/console/console.css`: `.sess-view` uses `overflow-x: clip` instead of `hidden`. `hidden` made `.sess-view` a scroll container, so the composer's `position: sticky` was measured against a box that never scrolls and never stuck. The composer now sticks at `bottom: var(--nav-total)`, which is the bottom nav height plus the phone's bottom inset. Every rule that sits above the bottom nav (page padding, toast, page-primary button, Files edit button, sheet padding) now uses one `--safe-b` / `--nav-total` pair instead of a mix of `--nav-h` with and without `env(safe-area-inset-bottom)`.
2. `dashboard/console/nav-model.js`: eleven legacy tabs whose content moved into another console page (Initiatives, Blockers, Send content, Tokens, PR pipeline, Evidence, Routing map, LLM activity, Throughput, Process health, Feedback drain) no longer get a tile. They move to a `MERGED` list. `allTabIds()` still includes them and `NATIVE_PAGES` still redirects each old link, so bookmarks and the legacy-coverage test keep working. Send content (`dropzone`) now redirects to Sessions, where each session's message box has its own attach button. The "Messages to you" tile no longer describes held replies.

## 1. Over-block
None. Not a gate.

## 2. Under-block
None. Not a gate.

## 3. Level-of-abstraction fit
Page layout and navigation data, owned by the console. Correct layer.

## 4. Signal vs authority
No decision point. Not applicable.

## 5. Interactions
Desktop (≥900px) resets the composer to `position: static` and turns the nav into a sidebar; the desktop rules that used `--nav-h` now use `--nav-total`, which equals `--nav-h` on a desktop browser (inset 0). `overflow-x: clip` keeps the no-sideways-scroll behaviour: checked at 390px, page scroll width 390 on Live and History.

## 6. External surfaces
Visible only in the console. Old `?tab=` links for merged tabs still land on their page.

## 6b. Operator-surface quality
The operator reported the session message box hidden in the Instar iPhone app. Reproduced on the live console at 390×844 and 390×640 with a simulated 68px app inset (the app's tab bar): the bottom nav covered the box at every scroll position. On the preview the box sits directly above the nav in all 12 cases (two heights × inset 68/0 × scroll top/middle/bottom). The Work page now shows Sessions, Schedule, Promises, Plans (plus Development and Feature maturation), with no "Now inside…" tiles.

## 7. Multi-machine posture
Static page code served per machine; no state. Machine-local by design.

## 8. Rollback cost
Revert the commit; no data or migration.
