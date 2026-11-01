# Remote desktop: readable not-ready reasons

## Summary

Tier 1: reason wording in src/core/DesktopProbeReadiness.ts and a list under the machine picker in the viewer.

## Over-block

None; readiness decisions are unchanged, only their text.

## Under-block

The fixes still require a person at the Mac (unlocking, macOS privacy permissions cannot be granted remotely). Lock-screen support is separate work.

## Level of abstraction

Wording lives with the probe interpretation; the viewer only displays it.

## Signal versus authority

No decision point changes.

## Interactions

Peer machines' reasons come from their own probes, so a peer on an older release shows its older wording.

## 6b. Operator-surface quality

Reasons were truncated inside a disabled select option on phones; they now show in full.

## External surfaces

None.

## Multi-machine posture

Each machine words its own reason; the front displays them.

## Rollback cost

Revert; text only.

## Class-Closure Declaration

`defectClass: operator-surface`, `closure: fix`, `guardEvidence: { enforcementType: unit-test, citation: tests/unit/desktop-probe-readiness.test.ts, howCaught: topic 134088 asked that not-ready reasons and permission steps be completable from the phone }`.
