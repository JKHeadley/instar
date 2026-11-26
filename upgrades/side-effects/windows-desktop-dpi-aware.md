# Windows desktop companion: declare DPI awareness

## Summary

Tier 1: one C# file in the Windows companion (13 added lines), plus docs. Effort: no spec rounds. `Main` calls `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` (falling back to `SetProcessDPIAware`) before any `Screen` or `SystemInformation` call. This also corrects the earlier side-effects note for the SendInput change: its "lid closed" explanation for the frozen picture was wrong. The picture only covered part of a scaled screen; Mama PC's lid was open.

## Over-block

None. No input is refused that was accepted before.

## Under-block

Mixed-DPI multi-monitor setups are untested; per-monitor v2 should report true pixels for each monitor, but only a single 150% display was tested live.

## Level of abstraction

The fix sits in the companion process start, the only place that can set process DPI awareness reliably. Admission, PIN, grant, encryption, lock, rate limits and Stop are unchanged.

## Signal versus authority

No decision point changes.

## Interactions

Frame size grows on scaled displays (1280x800 to 1920x1200 on Mama PC). Capture already scales down to 2560x1440 and steps JPEG quality to stay under the frame cap. The red banner keeps its pixel size, so it looks smaller on a scaled screen.

## 6b. Operator-surface quality

The viewer shows the whole remote screen and pointer alignment is correct. Nothing new to learn.

## External surfaces

No new ports, credentials, prompts or permissions.

## Multi-machine posture

Windows-only companion, machine-local by design. Mac hosts are untouched.

## Rollback cost

Revert the file; the next update reinstalls the previous companion. No state or migration.

## Class-Closure Declaration

`defectClass: environment-assumption`, `closure: fix`, `guardEvidence: { enforcementType: live-host-test, citation: src/native/remote-desktop/windows/InstarDesktopCompanion.cs, howCaught: Justin's phone test showed a zoomed, cropped picture and a tap clicking a button the drawn cursor was not on; the viewer reported 1280x800 for a 1920x1200 display at 150%, and after the fix a low-level mouse hook confirmed press and release at the targeted physical pixel }`.
