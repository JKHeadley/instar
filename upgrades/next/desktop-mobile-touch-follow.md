# Mobile remote desktop taps and zoom follow

## What Changed

On a phone, the remote desktop viewer now starts in Direct mode: a short tap clicks the exact point touched, and two quick taps reach the remote machine as two clicks. The viewer turns off iPhone text selection and browser touch gestures over its own controls, so a double tap no longer selects the Stop label or opens the magnifier. When zoomed in, the picture shifts to keep the pointer visible, and dragging a finger to an edge keeps panning until the finger lifts. Trackpad mode remains available in the control menu.

## What to Tell Your User

On your phone, tap where you want to click on the remote screen, and double tap to double click. When you zoom in, drag toward an edge and the picture follows, like AnyDesk mobile. The typing field still works normally.

## Summary of New Capabilities

Direct touch clicks by default on phones, double-tap as double click, and edge-follow panning while zoomed in the remote desktop viewer.

## Evidence

A phone-sized Chrome run against Laptop's real encrypted stream through the public link produced two remote click commands at the touched point from two taps, and passed pinch zoom, edge-follow pan, keyboard focus, Stop, and refusal after Stop. Unit tests cover the touch mapping and the browser touch policy; the desktop HTTP integration and production-boot E2E tests pass.
