# The locked-Mac password box no longer covers the Stop button

## What this is

Instar can show and control a Mac's screen from a web page, even while that Mac is locked. When the Mac is locked, the page shows a small box near the top of the screen where you type the Mac's password. The page also has a thin bar along the very top with the machine's name and a red Stop button, which ends the remote session.

## What went wrong

The password box was drawn on top of that bar, starting just half a line down from the top edge, and it is nearly as wide as the screen. So while the password box was showing, it sat over the Stop button. Clicking Stop clicked the box instead. The only way to end the session was to close the browser tab. This was found on 5 November 2026 by the locked-screen test on the Mac Mini: the test tried to click Stop for thirty seconds and the browser kept reporting that the password box was in the way. It matters most exactly when the box is showing because the Mac refused a password, which is when a person is most likely to want to give up and stop.

## What changes

The password box, and the one-line message that sometimes takes its place, now start just below the top bar instead of on top of it. Nothing else moves. The Stop button stays where it was and can be clicked at any time. On a phone the box sits about two and a half lines lower than before, which still leaves it in the top part of the screen above the keyboard.

## How it was checked

The page was loaded in a real browser at a laptop size (1280 by 728) and a phone size (390 by 844), switched into its live-session layout, with the password box showing. On the current code, the point in the middle of the Stop button belongs to the password box at both sizes. With this change it belongs to the Stop button at both sizes, and the box starts below it. A new unit test checks the style rule so the box cannot drift back over the bar unnoticed.

## What could go wrong

Very little. It is a two-line style change. If a future change makes the top bar taller, the box could overlap it again, which the new test would not catch by itself because it checks a fixed distance. Undoing this change is a plain revert.
