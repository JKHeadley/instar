# Native desktop: continuous Mac capture

<!-- bump: patch -->

## What Changed

The first Mac remote desktop target now captures its screen through one persistent ScreenCaptureKit helper per grant. It keeps the newest frame, sends bounded JPEGs, and skips unchanged images. The sender retries a changed frame dropped for bandwidth and stops native capture immediately when access ends. PIN-only entry, one controller, ten-minute grant, and Stop remain the operator flow.

## What to Tell Your User

Open the same Remote desktop page and enter the dashboard PIN. The Mac should update more often during motion while Stop remains immediate. This is a Mac quality pass; Windows and Linux host support and measured AnyDesk-level smoothness are still acceptance work.

## Summary of New Capabilities

- Continuous native Mac screen capture with bounded frame and bandwidth use.
- Dropped changed frames are offered again without requiring another screen change.

## Evidence

Focused unit tests pass. A local 12-second motion check observed 145 distinct native images from 213 requests with no capture errors. HTTP integration, production-boot, public-browser, and full-suite results are recorded in `upgrades/side-effects/native-remote-desktop-continuous-capture.md` before release.
