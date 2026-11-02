---
title: Remote desktop multiple screens and three-finger gestures
slug: desktop-multi-display-gestures
author: echo
status: draft
tier: 1
eli16-overview: docs/specs/desktop-multi-display-gestures.eli16.md
---

# Remote desktop: multiple screens and three-finger gestures

## Problem

The operator tested the native iPhone viewer against a laptop with three screens.

- macOS capture, pointer and cursor readback all use `CGMainDisplayID()`. Only the main screen can be seen or clicked. `displayCount` is reported but nothing uses it.
- Windows captures `SystemInformation.VirtualScreen`: every screen squeezed into one picture. Pointer and cursor use the same rectangle.
- No viewer has a way to show Mission Control, App Exposé or switch Spaces short of latching Ctrl by hand.

## Displays

One read: `GET /desktop/requests/:id/displays`, authorised exactly like `/cursor` (viewer session plus a valid grant), relayed by the mesh broker as a new `displays` operation.

```json
{ "supported": true, "platform": "macos", "canShowAll": false, "currentDisplayId": "1",
  "displays": [{ "id": "1", "name": "Built-in Retina Display", "width": 3024, "height": 1964, "main": true }] }
```

- `id` is opaque text matching `^[A-Za-z0-9_-]{1,32}$`: `CGDirectDisplayID` on macOS, `DISPLAY1` on Windows. Names are host text: control characters stripped, 64 characters at most. Resolution is real pixels. Mirrored Mac screens are left out, because a mirror shows the same picture.
- `canShowAll` is true on Windows, where "All screens" (`currentDisplayId: null`) stays the default so nothing changes for anyone who never opens the picker. macOS has no equivalent, and null there means the main display.

One command: `{ type: 'input', action: { kind: 'selectDisplay', displayId } }` over the existing encrypted stream.

- It rides the input stream so it is authenticated by the session key, ordered with clicks, and relayed by the front without any new relay code.
- `DirectDesktopAccess.input` handles it and never passes it to `host.input`. A well-formed id that is not on the machine leaves the display unchanged and keeps the session; the viewer re-reads the list and shows the truth. A malformed id is a protocol violation and closes the stream, like any other bad command.
- macOS: the capture helper is restarted with the new display id, `forceKeyframe` is raised, and the viewer's existing size-change handling draws the new picture. Pointer actions carry `displayId` to the input helper, so they map to that screen's bounds. The socket, grant, key and 10-minute deadline are untouched.
- Windows: capture, cursor and input requests carry an optional `displayId`; the companion uses that screen's rectangle, and without it behaves exactly as before.
- The choice belongs to the logical session (`row.displayId`). It survives a resume and is cleared for a new grant.
- If the chosen display disappears, the next capture after a failure re-reads the list and returns to the default display. An empty list means the desktop could not be read (a UAC prompt, the lock screen) and changes nothing. A click landing in the instant the screen vanishes fails closed and ends the session, because clicking elsewhere would be worse.
- While a switch settles the picture still shows the old screen. The viewer holds pointer presses until a frame arrives at least 400 ms after the switch, or for 3 seconds at most.
- Viewers re-read the list every 30 seconds, which picks up a screen plugged in or removed. One failed re-read keeps the working controls; only a machine that never answered is shown as needing an update.

After switching, the viewer moves the pointer to the centre of the chosen screen. macOS applies Spaces shortcuts to the screen under the pointer, so this makes the gestures act on the screen being viewed.

### Older hosts

An older host treats an unknown command as a protocol violation and ends the session, so a viewer must never send `selectDisplay` on a guess. It sends it only after `displays` answers `supported: true`.

| Situation | What `displays` gives | What the viewer does |
|---|---|---|
| Older server, front or peer | 404 or 403 | No picker, no gestures, a plain note that this machine needs an update |
| New server, older helper or companion | `supported: false`, `platform` still set | No picker, plain note, gestures still work |
| One screen | `supported: true`, one row | No picker, gestures work |

## Gestures

Sent as ordinary `keyDown`/`keyUp` through the existing input path. All these keys already exist on every host, so no new key is required.

| Three fingers | macOS | Windows |
|---|---|---|
| Up | Control+Up (Mission Control) | Win+Tab (Task View) |
| Down | Control+Down (App Exposé) | nothing, unless an overview is open |
| Down while an overview is open | Escape (back) | Escape (back) |
| Up while App Exposé is open | Escape (back) | not applicable |
| Up while Mission Control or Task View is open | nothing | nothing |
| Swipe left | Control+Right (next Space) | Ctrl+Win+Right |
| Swipe right | Control+Left (previous Space) | Ctrl+Win+Left |

- The direction matches a Mac trackpad: the desktop follows the fingers, so swiping left brings in the one on the right.
- The viewer remembers that it opened an overview and uses Escape to go back. A click or tap forgets it, because the overview may have closed.
- A modifier the operator has already latched is left held, not released.
- The gesture fires once per swipe, after 60 points of travel with one axis clearly dominant. It is ignored while a button is held.
- The same actions are buttons in the viewer's tools, for mouse users and for phones where the system takes three fingers.
- macOS registers these shortcuts with the Fn flag (the stored hotkey modifiers are `0x840000`, Control plus Fn), and physical arrow keys carry Fn and NumericPad. The helper now sets both flags on arrow key events, matching a real keyboard.

### What can stop a gesture

- These shortcuts can be turned off or changed per Mac in System Settings › Keyboard › Keyboard Shortcuts › Mission Control. The "Move left/right a space" pair can be off. The viewer cannot tell, so a gesture on such a Mac does nothing; the viewer shows which shortcut it sent.
- Mobile Safari may take three-finger touches for its undo gesture. The native app can opt out; the web page cannot, and the buttons are the fallback there.
- Spaces apply per screen only when "Displays have separate Spaces" is on, which is the macOS default.

## On-machine indicator

The Windows "Instar remote control active" banner sat at the top right and covered window buttons. It is now a small borderless strip at the bottom right of the main screen's working area, sized to its text, still always on top. Dragging it moves it, so the person at the machine or the viewer can put it elsewhere; it cannot be dragged off screen, and the spot is kept for later sessions until the companion restarts. Closing it still ends control. The Mac indicator is a menu bar item, which never covers windows, so it is unchanged.

## Double-tap and hold

Tap, then press and hold, then move must drag: mouse down, moves, mouse up. It used to send the first tap's click at once, then the press. The two together read on the host as a double-click, so grabbing a window's title bar maximized it. Both viewers now hold a lone tap's click for the 300 ms double-tap window. A second tap in that window cancels it: if the finger lifts quickly, one double-click goes out; if it holds and moves, a drag; if it holds without moving, one click. A lone tap therefore clicks about 300 ms later than before; that delay is the cost of telling the two apart.

## Verification

Tests exercise the protocol, the hosts against fake helpers, the routes and the production boot path. The Swift helper is compiled here. The C# companion cannot be compiled here. Nothing was run against a real screen. Before calling this working, a live check must show: three real screens listed with their right names and resolutions; switching among them with correct click placement, including a screen left of or above the main one; and each gesture doing its job on a Mac and on Mama PC.

## Rollback

Revert the change. No stored state or migration. Viewers fall back to the older-host row above.
