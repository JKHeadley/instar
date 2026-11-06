## What Changed
The remote desktop page's locked-Mac password box (`#lockedPassword`) and its reason line (`#lockedPasswordReason`) now start below the top bar (`.desktop-bar`) instead of over it. Before, the box sat at z-index 8 from `top: .5rem` and nearly full width, above the bar's Stop button (z-index 5, `top: 0`), so a click on Stop landed on the box while it showed and a person could only end the session by closing the tab. `dashboard/desktop.css` only.

## What to Tell Your User
On the remote desktop page, the Stop button now works while the Mac's password box is showing. Before, the password box covered it.

## Summary of New Capabilities
None. This fixes the Stop button on the remote desktop page while the locked-Mac password box is showing.

## Evidence
Live, 2026-11-05 18:32 PST, locked-screen proof case 12.5a on the Mac Mini: `page.click('#stopButton')` timed out after 30 s with "element is visible, enabled and stable … <form id="lockedPassword">…</form> intercepts pointer events". Reproduced in a headless Chrome render of `dashboard/desktop.html` in its live layout with the password box shown: on main, `elementFromPoint` at the Stop button's centre returns `lockedPassword` at 1280x728 and 390x844; with this change it returns `stopButton` at both sizes and the box's top is at 52 px, below the button's bottom at 36 px. `tests/unit/desktop-locked-password-clears-stop.test.ts` fails on main's stylesheet and passes with this one.
