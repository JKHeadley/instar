# Native desktop: laptop pointer and scroll

<!-- bump: patch -->

## What Changed

The viewer pointer now has a black outline on white backgrounds. Laptop trackpad two-finger scrolling is sent to the remote Mac through the existing bounded input path. The Trackpad / Direct switch is hidden on devices without touch input; on touchscreens it labels the difference between relative pointer movement and touching a position directly.

## What to Tell Your User

On your MacBook, move and click normally, and scroll with two fingers over the remote desktop. The touch-mode switch no longer appears on a mouse-only device. The pointer stays visible on white windows.

## Summary of New Capabilities

- A visible pointer on light backgrounds.
- Laptop wheel and trackpad scrolling through the remote desktop input path.
- Touch-mode labels and visibility that match the input device.

## Evidence

The browser unit test checks wheel-event normalization and batching and verifies that browser pinch events are not sent as remote scroll. The public laptop browser check confirms the live viewer receives a full-resolution stream and Stop revokes access.
