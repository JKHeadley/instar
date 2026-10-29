# Native desktop: full-resolution Mac stream

<!-- bump: patch -->

## What Changed

The Mac remote desktop now captures up to 1920 × 1080 pixels instead of shrinking a 1080p desktop to 960 × 540. Hardware H.264 uses AVC Baseline level 4.0 and a 5 Mbps encoder target. The JPEG fallback also keeps the full pixel dimensions and uses higher quality when the bounded frame fits. The sender remains capped at 15 requests per second with a 10 Mbps byte budget and bounded frame and queue sizes.

## What to Tell Your User

The Echo Mac desktop should look sharper on a laptop. Open the same desktop link with the same dashboard PIN; no new setup is needed. The browser still scales the full image to fit its window.

## Summary of New Capabilities

- Full HD Mac screen streaming when the display is 1080p or larger.
- Higher-resolution JPEG compatibility when the browser cannot decode the H.264 profile.

## Evidence

Echo's 1920 × 1080 Mac display returned a full-resolution H.264 keyframe that ffmpeg decoded and a complete full-resolution JPEG. Focused protocol, stream, native host, grant, and browser viewer tests passed. A fresh public HTTPS Chrome session received encrypted 1920 × 1080 H.264 video and confirmed Stop, a blank viewer, and native helper cleanup; a second run passed. The full test tiers remain release checks.
