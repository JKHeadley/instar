# Remote desktop: AnyDesk-style gestures, more keys, double and middle click

## What Changed

The browser remote desktop viewer and both host helpers (macOS and Windows) share a wider input set. Clicks can carry a count (double and triple click) and use the middle button. Keys now include F1 to F12, Home, End, Page Up, Page Down, Insert, and every letter and digit, so Ctrl or Cmd works with any of them. Phone gestures follow the AnyDesk research report: tap clicks, long press or two-finger tap right-clicks, three-finger tap middle-clicks, double-tap and hold then move drags, two fingers scroll in the natural direction, pinch zooms up to 5x and the view keeps the cursor centred. A quick mouse click in a desktop browser goes out as one click instead of a press and release a network round trip apart. While the viewer is open and visible it sends a light ping every 30 seconds, so watching without touching no longer ends the session at the two-minute idle limit.

## What to Tell Your User

Remote desktop on your phone now works like AnyDesk: hold or two-finger tap to right-click, double-tap and hold to drag, scroll with two fingers like on the phone itself, and use the tools panel for F-keys, Home, End and Page keys. With Ctrl or Cmd latched, typing a letter sends the shortcut. The session stays open while you are just watching.

## Summary of New Capabilities

Double, triple and middle click; F-keys and navigation keys; modifier shortcuts with any letter or digit; AnyDesk-style touch gestures; idle limit no longer ends a watched session.

## Evidence

Unit tests: tests/unit/desktop-anydesk-gestures.test.ts (mouse quick click as one click, mouse drag, two- and three-finger taps, long press, natural scroll direction, double-tap-hold drag, Ctrl shortcut typing) and tests/unit/desktop-input-protocol.test.ts (shared validator, every key mapped by both helpers). The macOS helper builds with swiftc. Live verification on Mama PC and the Studio follows in this run.
