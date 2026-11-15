---
title: Windows Remote Desktop video (H.264)
slug: windows-desktop-video
tier: 1
eli16-overview: docs/specs/windows-desktop-video.eli16.md
---

# Windows Remote Desktop video (H.264)

## Problem

Remote Desktop on a Windows host (WSL agent + interactive companion) delivers
JPEG pictures at 5.5-5.8 per second on Mama PC (measured 2026-11-02, topic 131439).
Each picture costs ~80 ms on the Windows side (GDI copy + GDI+ JPEG) and ~120 ms
crossing WSL (a 200-400 KB JPEG base64'd through the PowerShell relay). The viewer
and the session authority already negotiate H.264 (`desktop-video-v1:annexb:avc1.420028:1920x1080:g1`)
and the Mac host already serves it; the Windows host had no `captureH264`, so every
Windows session stayed on JPEG.

## Design

1. **Companion** (`InstarDesktopCompanion.cs`, still one file compiled by
   PowerShell `Add-Type`, C# 5, no unsafe code) gains a `capture-h264` operation
   (same HMAC, lease and interactive-desktop checks as `capture`) and a
   `VideoStream` per lease and screen area:
   - capture thread: GDI `BitBlt` of the shown area into a reused DIB (~53 ms at 1920x1200);
   - encode thread: Windows Video Processor MFT scales into the contract
     (largest even size ≤1920x1080 with the area's shape) and converts to NV12
     (~8 ms), then the Media Foundation H.264 encoder (hardware first — Quick
     Sync/NVENC/AMF async MFT — then Microsoft's software MFT) in baseline
     level 4.0, low-latency, no B-frames, quality-based rate control (quality 70; mean bitrate ≈0.15 bit/pixel at 15/s kept as the fallback target) (~11-20 ms);
   - at most one encoded access unit waits; a request takes it, so every delta
     reaches the viewer in order and transport overlaps the next capture.
   - keyframe requests drop a waiting delta and force an IDR; every keyframe
     carries SPS+PPS (cached from the encoder when it emits a bare IDR).
   - the request validates under the companion gate, then waits for a unit
     outside it (≤50 ms; ≤300 ms for a keyframe) so input/heartbeat/Stop are
     never queued behind video; an empty 200 means "no new picture yet".
   - Stop / lease loss / a new area / 4 s without a request stops the threads.
     An encoder failure fails the stream for that lease (one error reply).
2. **Relay** (`windows-desktop-local-transport.ps1`) and **transport**
   (`WindowsDesktopLocalTransport.ts`) allow `capture-h264` on the picture lane and the
   `video/h264` reply type.
3. **Host** (`WindowsDesktopHost.ts`) exposes `captureH264` only when the switch is on;
   it returns `parseNativeH264(packet)` or null on an empty reply. Any error lets
   `DirectDesktopAccess` downgrade that session to JPEG (existing behaviour, unchanged).
4. **Switch** `remoteDesktop.windowsVideo.enabled`: explicit value wins; omitted ⇒ on for
   a `developmentAgent`, off on the fleet (`resolveWindowsDesktopVideo`).

5. **Pace**: `DesktopStreamSession.frameIntervalMs` (bounded 50-67 ms) lets a live H.264
   session be polled faster than the default 15/s; `DirectDesktopAccess` returns the host's
   `videoFrameIntervalMs` only while the session is on H.264, and the Windows host declares 50 ms
   (its companion captures up to 20/s). Every other session keeps 67 ms.

Input, lock, PIN, banner, grant and Stop paths are unchanged. The 10 Mbps budget is unchanged.

## Compatibility

- Older companion + new server: `capture-h264` is refused (400) → one failed request,
  session continues on JPEG.
- Older relay script: the op is refused by its ValidateSet/allowlist → same fallback.
- New companion + older server: the op is never requested.

## Measured prototype (Mama PC, Intel Iris Xe, 1920x1200 at 150 %)

- Encoders: hardware MFT 1:1 in/out, ~11 ms NV12→AU; software MFT ~6 ms; both
  decode cleanly as Constrained Baseline level 4.0 (ffprobe/ffmpeg).
- Pipeline production rate on the real screen: 18.7 pictures/s, ~36 KB per delta.

## Tests

- Unit `tests/unit/windows-desktop-video.test.ts`, `tests/unit/windows-desktop-local-transport.test.ts`.
- Integration `tests/integration/windows-desktop-video.test.ts` (real DirectDesktopAccess + host, HMAC-checking companion stand-in).
- E2E `tests/e2e/windows-desktop-video-lifecycle.test.ts` (production wiring; live WSL run against the real companion).

## Rollback

Set `remoteDesktop.windowsVideo.enabled: false` (immediate, JPEG), or revert.
