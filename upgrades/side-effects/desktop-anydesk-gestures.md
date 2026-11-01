# Remote desktop: shared input protocol and AnyDesk-style gestures

## Summary

Tier 1 by size per file but touches three surfaces (browser viewer, macOS helper, Windows companion) plus a shared TypeScript validator. Every change is additive to the input vocabulary; admission, PIN, grant, encryption, controller lock, rate limits and Stop are unchanged.

## Over-block

None new. The Windows host now runs the shared validator before forwarding to the companion; anything it refuses the companion already refused.

## Under-block

Ctrl+Alt+Del on Windows is not offered: Windows accepts the secure attention sequence only from a system service or a signed accessibility app, and the companion runs in the user's session. Ctrl+Shift+Esc (Task Manager) works with the existing key path.

## Level of abstraction

Key names and button names live in one list (src/core/DesktopHost.ts) used by both hosts; each helper maps the names to its OS codes. A unit test checks both helpers map every listed key.

## Signal versus authority

No decision point changes.

## Interactions

Version skew: a newer viewer talking to a host still on the previous release may send a key or middle button that older host refuses, which ends that input with the existing input-failed close. Hosts update with the same release, so the window is the update interval. The 30-second visible ping counts as activity, exactly as the hold heartbeat already did; the ten-minute grant limit is unchanged.

## 6b. Operator-surface quality

Gestures now match the AnyDesk report and the native iPhone viewer (topic 134088). The tools panel gains Del, Home, End, PgUp, PgDn and F1 to F12.

## External surfaces

No new ports, credentials, prompts or permissions.

## Multi-machine posture

Each host runs its own helper; the front only relays encrypted commands and is unchanged.

## Rollback cost

Revert the commit; the next update reinstalls the previous helpers. No state or migration.

## Class-Closure Declaration

`defectClass: missing-capability`, `closure: fix`, `guardEvidence: { enforcementType: unit-test, citation: tests/unit/desktop-input-protocol.test.ts, howCaught: Justin asked that browser and native viewers match AnyDesk; topic 134088's research report listed the gestures and keys, and a live mouse hook on Mama PC showed a 1.2 s press-release gap for browser mouse clicks }`.
