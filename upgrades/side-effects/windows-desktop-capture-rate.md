# Windows desktop capture rate

## Summary

Tier 1: companion `Capture` skips the same-size bicubic redraw and caches the JPEG codec; `DesktopStreamManager` paces from tick start (minimum 5 ms between grabs); the PowerShell relay adds `ms` to each reply, passed as `X-Instar-Relay-Ms` and totalled by `WindowsDesktopHost.captureTiming()`; the stream close line adds `hostCaptureMsAvg`.

## Over-block

None.

## Under-block

The rate is still bounded by one capture at a time per session; the remaining gap between Windows-side time and total capture time is now measurable, not removed.

## Level of abstraction

Each change sits where the time is spent: the helper's encode, the stream's pacing, the relay's own clock.

## Signal versus authority

No decision point changes.

## Interactions

Pacing can raise grab frequency up to the existing 15-per-second ceiling; the existing bandwidth allowance and send-buffer checks still apply. A screen larger than 2560x1440 is still scaled as before. Older relay scripts send no `ms`; the timing is then omitted, nothing else changes.

## 6b. Operator-surface quality

Smoother motion on Windows hosts.

## External surfaces

None.

## Multi-machine posture

Machine-local to each Windows host and its WSL agent.

## Rollback cost

Revert; the next update reinstalls the previous helper and script.

## Class-Closure Declaration

`defectClass: performance`, `closure: fix`, `guardEvidence: { enforcementType: unit-test, citation: tests/unit/windows-desktop-capture-rate.test.ts, howCaught: per-session picture counts on Mama PC showed no drops but 200 ms average grabs against about 80 ms of Windows-side work }`.
