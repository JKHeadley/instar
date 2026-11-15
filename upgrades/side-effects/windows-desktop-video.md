# Side-Effects Review — Windows Remote Desktop video (H.264)

**Version / slug:** `windows-desktop-video`
**Date:** `2026-11-14`
**Author:** `Echo`
**Second-pass reviewer:** `not required (no gate, sentinel, watchdog or messaging decision); independent code review of the companion interop recorded below`

## Summary of the change

The Windows desktop companion (`src/native/remote-desktop/windows/InstarDesktopCompanion.cs`) gains a `capture-h264` operation backed by a per-lease `VideoStream`: a GDI capture thread and an encode thread (Video Processor MFT scale + NV12, Media Foundation H.264 encoder, hardware first then software). The PowerShell relay (`scripts/windows-desktop-local-transport.ps1`) and transport (`src/core/WindowsDesktopLocalTransport.ts`) carry the op and the `video/h264` type. `WindowsDesktopHost` exposes `captureH264` only when `remoteDesktop.windowsVideo.enabled` resolves true (explicit, else `developmentAgent`), wired in `AgentServer`. `DirectDesktopAccess` is unchanged: it already uses `captureH264` when present and downgrades a session to JPEG on any error.

## Decision-point inventory

- `resolveWindowsDesktopVideo` (new) — add — a configuration switch (explicit setting, else development agent); it chooses a codec path, it does not block or allow any action.
- Companion `capture-h264` admission — pass-through — reuses the existing HMAC, replay, lease-ownership and interactive-desktop checks of `capture`, verbatim.
- `DirectDesktopAccess` h264→JPEG downgrade — pass-through — unchanged.

---

## 1. Over-block

No block/allow surface. A machine where video fails (no encoder, Video Processor unavailable, encoder error) loses only video for that session and keeps JPEG.

## 2. Under-block

No block/allow surface. Residual quality gaps: a multi-monitor "all screens" view is scaled to fit 1920x1080 (as wide as the contract allows), so text on a very wide virtual screen is smaller than with JPEG at 2560x1440; a viewer can pick one screen to get full size. GDI capture still returns the last frame when the physical display is off (unchanged from JPEG).

## 3. Level-of-abstraction fit

Encoding lives in the Windows companion, next to capture, mirroring the Mac host's native H.264 helper; the WSL host only parses the native packet with the shared `parseNativeH264`. Codec negotiation and fallback stay in `DirectDesktopAccess`, the existing authority for the session. No parallel mechanism.

## 4. Signal vs authority compliance

No decision point gates information or actions; the switch selects an encoding. Not applicable beyond that.

## 4b. Judgment-point check

No competing-signals decision point added.

## 5. Interactions

- The companion serves requests one at a time. The video request validates under the gate and then waits outside it, ≤50 ms (≤300 ms for a forced keyframe), so input, heartbeat and Stop requests wait at most that long behind video, less than today's ~80 ms JPEG capture held under the gate.
- `StopLocked` (Stop, lost heartbeat, desktop no longer interactive) stops video threads first; a stream also stops itself after 4 s without a request, and is replaced when the shown area changes (display picker).
- The relay's picture lane carries both `capture` and `capture-h264`; input stays on its own lane.
- `DesktopStreamManager` pacing (15/s), byte budget (10 Mbps) and keyframe-on-drop behaviour are unchanged; deltas are ~36 KB, keyframes ~70-140 KB, under the 1.25 MB frame cap.
- Banner, lease, `SetThreadExecutionState`, DPI awareness: untouched.

## 6. External surfaces

Windows hosts with the switch on send H.264 to the browser viewer (already supported: `VideoDecoder` with `avc1.420028`) and to the native app viewer (already supported for Macs). The companion binary is rebuilt by the existing install/update handoff; an older companion or relay refuses the op and the session falls back to JPEG after one request.

## 6b. Operator-surface quality

No dashboard markup or form changes. The operator sees smoother Windows video when on.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each Windows host encodes its own screen; the switch is read from that host's own config, which is where the companion runs. No new status surface; the stream's close line already reports codec and host timing (`hostCaptureMsAvg`, now including video).

## 8. Rollback cost

`remoteDesktop.windowsVideo.enabled: false` on the host (takes effect on server restart; the next session is JPEG), or revert the PR; the next update reinstalls the previous companion and relay. No state or data migration.

## Conclusion

Dark-by-default capability that reuses the existing video contract, negotiation and fallback; failure degrades to today's behaviour. Clear to ship after the live measurement on Mama PC.

## Second-pass review (if required)

**Reviewer:** not required by category; independent code review of the companion interop: see Evidence.

## Evidence pointers

- Unit: `tests/unit/windows-desktop-video.test.ts`, `tests/unit/windows-desktop-local-transport.test.ts`.
- Integration: `tests/integration/windows-desktop-video.test.ts`.
- E2E: `tests/e2e/windows-desktop-video-lifecycle.test.ts` (wiring always; live WSL measurement with `WINDOWS_DESKTOP_VIDEO_LIVE_TEST=1`).
- Prototype on Mama PC: both encoders 1:1, streams decode as Constrained Baseline 4.0; real-screen pipeline 18.7 pictures/s.
