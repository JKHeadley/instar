# Native desktop: full viewport mobile controls

<!-- bump: patch -->

## What Changed

The live remote desktop uses the full browser viewport, with Stop and a compact control dock over the image. Two-finger pinch zooms up to 4× and a Fit button restores the whole screen. The keyboard button focuses a typing field in the same tap so mobile browsers can open their software keyboard. The shortcut controls remain available from the dock.

## What to Tell Your User

Open the same desktop link and enter the same dashboard PIN. Rotate your phone to landscape for the widest view. Pinch to zoom, tap **Fit** to see the whole desktop, and tap the keyboard icon to type. **Stop** ends access immediately.

## Summary of New Capabilities

- Full viewport remote desktop with floating controls.
- Pinch zoom, local pan, and one-tap mobile keyboard focus.

## Evidence

Focused gesture tests cover zoom, scroll, keyboard input, and cleanup. A public HTTPS browser check received a live 1920 × 1080 H.264 frame in portrait and landscape emulation, verified viewport fill, pinch zoom, keyboard focus, and Stop/revocation. Physical iOS keyboard appearance remains a device check.
