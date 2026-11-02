# Remote desktop: multiple screens and three-finger gestures

## What Changed

The remote desktop viewer can now list a machine's screens and switch between them during a session, without reconnecting. `GET /desktop/requests/:id/displays` reports each screen's name, resolution and whether it is the main one, plus the machine's platform. Switching is a new `selectDisplay` action on the encrypted stream, sent only after the machine reports support, because an older host ends the session on a command it does not know. The macOS helper captures and maps the pointer on the chosen screen. The Windows companion can show one screen, and all screens in one picture stays the default.

Three-finger swipes send the machine's standard shortcuts through the existing input path: Mission Control, App Exposé and Spaces on a Mac, Task View and Ctrl+Win+arrows on Windows. The same actions are buttons in the tools panel. Arrow keys posted on a Mac now carry the Fn and NumericPad flags a physical keyboard sends, because macOS registers these shortcuts with Fn set.

The Windows "Instar remote control active" banner no longer sits over window buttons. It is a small always-on-top strip at the bottom right that either person can drag, and it cannot leave the screen.

On a phone, double-tap and hold now drags with no click pair, so dragging a window by its title bar no longer maximizes it. A lone tap's click waits about 300 ms to tell it apart from a double tap.

## What to Tell Your User

Remote desktop now handles more than one screen. A Screens button lists them by name and size, and tapping one switches to it without reconnecting. Three-finger swipes work like a Mac trackpad: up shows everything, down shows the app's windows or goes back, and left and right change desktops. If a swipe does nothing on a Mac, those shortcuts are turned off in its Keyboard settings. On Windows the "remote control active" banner has moved to the bottom right, and you can drag it. On a phone, double-tap and hold now drags instead of maximizing a window, so a single tap clicks a moment later than before.

## Summary of New Capabilities

Screen list and switching during a remote desktop session; three-finger desktop gestures and matching buttons; a movable Windows indicator.

## Evidence

Unit tests: tests/unit/desktop-displays.test.ts (hosts against a fake helper, grant authority, older-host behaviour, unplugged screen), tests/unit/desktop-three-finger-gestures.test.ts (viewer gestures, picker, older host), tests/unit/desktop-mesh-broker.test.ts (relay). Integration: tests/integration/desktop-routes.test.ts. E2E: tests/e2e/desktop-displays-boot-lifecycle.test.ts. The macOS helper compiles. The Windows companion was not compiled, and nothing has run against a real screen yet.
