# Native desktop: continuous Mac capture

<!-- bump: patch -->

## What Changed

The first Mac remote desktop target now captures its screen through one persistent ScreenCaptureKit helper per grant. It keeps the newest frame, sends bounded JPEGs, and skips unchanged images. The sender retries a changed frame dropped for bandwidth and stops native capture immediately when access ends. PIN-only entry, one controller, ten-minute grant, and Stop remain the operator flow.

## What to Tell Your User

Open the same Remote desktop page and enter the dashboard PIN. The Mac should update more often during motion while Stop remains immediate. This is a Mac quality pass; Windows and Linux host support and measured AnyDesk-level smoothness are still acceptance work.

## Summary of New Capabilities

- Continuous native Mac screen capture with bounded frame and bandwidth use.
- Dropped changed frames are offered again without requiring another screen change.
- Wake recovery checks the current public tunnel before restarting it, preserving reachable desktop sessions.
- A viewer whose connection is lost can resume the same logical access session with fresh keys when the target authorizes it. The current browser can also replace a half-open old stream with a signed proof bound to that stream. Stop, expiry, and revocation never resume.

## Evidence

Focused unit tests and the live Mac production-boot check pass. A local 12-second motion check observed 145 distinct native images from 213 requests with no capture errors. A current 12.5-second public phone-emulated motion check loaded 211 images, about 16.9 per second. A controlled half-open browser disconnect recovered to a new encrypted stream in about 1.1 seconds and Stop revoked it. A second run recovered from two lost status responses, one lost ticket response and two half-open WebSocket drops, then Stop revoked the third stream. A fresh public phone-emulated browser stayed live for eight active minutes with changed images at all sixteen checks, touch input, and immediate Stop. The full suite and physical phone checks remain release work, tracked in `upgrades/side-effects/native-remote-desktop-continuous-capture.md`.
