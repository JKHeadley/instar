<!-- bump: patch -->
## What Changed

Remote Desktop on Windows hosts can send real H.264 video instead of JPEG pictures. The Windows desktop companion gains a `capture-h264` operation: a capture thread copies the screen while an encode thread scales it into the existing viewer contract (baseline level 4.0, at most 1920x1080) with the Windows Video Processor and encodes it with Media Foundation (the hardware encoder when present — Intel Quick Sync, NVIDIA, AMD — else Windows' software encoder). One encoded picture waits for each request, so the slow WSL crossing overlaps the next capture. The relay and transport carry the new operation and `video/h264` replies; `WindowsDesktopHost` offers video only when `remoteDesktop.windowsVideo.enabled` is on (omitted: on for development agents, off on the fleet). Any video failure keeps that session on pictures, as before.

## What to Tell Your User

If you use Remote Desktop to see a Windows computer, it can now show smooth video instead of a choppy slideshow. It is switched off by default for now; I can turn it on for your Windows machine if you'd like to try it.

## Summary of New Capabilities

- H.264 video from Windows Remote Desktop hosts (switch: `remoteDesktop.windowsVideo.enabled`).

## Evidence

- Unit: `tests/unit/windows-desktop-video.test.ts`, `tests/unit/windows-desktop-local-transport.test.ts`.
- Integration: `tests/integration/windows-desktop-video.test.ts`.
- E2E: `tests/e2e/windows-desktop-video-lifecycle.test.ts`.
