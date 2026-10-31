# Windows desktop companion: SendInput mouse and display-on during a session

## Summary

Tier 1: one C# file in the Windows companion (about 30 changed lines), plus docs. Effort: no spec rounds. Mouse move, buttons and wheel now go through SendInput (move, then press, then release, each checked); while a lease is active the banner thread holds ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED, released when the banner thread ends.

## Over-block

A SendInput call that Windows refuses (returns 0, for example input blocked by a higher-integrity foreground window) now fails that input command instead of silently doing nothing. That is the honest result, not a new refusal of legitimate input.

## Under-block

A laptop with its lid closed keeps its built-in display off regardless of the execution-state request, so the picture can still be frozen there. The companion does not yet detect a powered-off display and report it on the card; that is tracked as ACT-172 within this rollout. <!-- tracked: ACT-172 -->

## Level of abstraction

The change stays inside the companion's input and lease-lifetime code. Admission, PIN, signed grant, encryption, controller lock, rate limits and Stop are unchanged.

## Signal versus authority

No decision point changes. Input still requires an active, unexpired lease; the display request is tied to the same banner thread whose exit already ends the lease.

## Interactions

The display request lives on the banner thread, so Stop, lease expiry, banner close and companion exit all end it. Held-button release on Stop now also goes through SendInput.

## 6b. Operator-surface quality

No operator surface changes. The Windows screen still shows the same red banner while connected.

## External surfaces

Windows power settings are not modified; the request is per-session and ends with it. No new ports, credentials, prompts or permissions.

## Multi-machine posture

Windows-only companion, machine-local by design: each Windows host runs its own companion. Mac hosts are untouched.

## Rollback cost

Revert the file; the next update reinstalls the previous companion. No state or migration.

## Class-Closure Declaration

`defectClass: environment-assumption`, `closure: fix`, `guardEvidence: { enforcementType: live-host-test, citation: src/native/remote-desktop/windows/InstarDesktopCompanion.cs, howCaught: live Mama PC test showed a frozen picture and no visible click effect; a probe in the interactive session received injected clicks, the monitor reported Off Line with a 10-minute battery screen-off, and the captured frame never changed across inputs }`.
