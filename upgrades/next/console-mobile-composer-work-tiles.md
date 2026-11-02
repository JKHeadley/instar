## What Changed

- On a phone, the session message box now stays just above the dashboard's bottom bar, including inside the Instar iPhone app, whose own tab bar used to push the box underneath. A sideways-scroll rule had also stopped the box from staying pinned; that is fixed.
- The dashboard menus no longer show tiles that only say where their content moved ("Now inside Plans" and similar). Old links to those pages still open the page they moved into. The Send content tile is gone; attach files from the session's own message box.

## What to Tell Your User

On your phone, the box for typing to a session is visible again at the bottom of the screen, including in the Instar app. The Work, Capacity and Settings menus are shorter: tiles that only pointed to another page are gone, and their old links still work.

## Evidence

- Reproduced on the live dashboard at 390×844 and 390×640 with a simulated 68px app tab bar: the bottom bar covered the message box at every scroll position.
- After the fix, on the preview: the box sits directly above the bottom bar in all 12 checked cases (two heights, with and without the tab bar, scrolled top/middle/bottom), and the page still does not scroll sideways.

## Summary of New Capabilities

None. This fixes the phone layout and tidies the menus.
