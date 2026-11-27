# Side-Effects Review — Remote Desktop: a sleeping Mac display is not a lock

**Version / slug:** `desktop-display-sleep-not-a-lock`
**Date:** `2026-11-27`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent review, 2026-11-27 15:36 PT — concur`
**Reviewer:** independent second-pass subagent (fresh context, given the code not the author's conclusion); verdict concur, no blocking defect

## Summary of the change

Tier 2: 4 source files, 1 new module, 2 new test files. On 2026-11-27 the Studio's display slept, and its helper's session flag (`CGSSessionScreenIsLocked`) read true while macOS's own console lock (`IOConsoleLocked`) read false. Three seconds of declared user activity cleared the flag with no password (Machine Stewardship). Remote Desktop refused that Mac as "not ready", like a locked one. `DirectDesktopAccess` admission (`begin` and `resume`) now calls `admissionProbe`. When the probe is not ready only because the session is not active, and both permissions are held, it asks the host to wake the display once, then rereads readiness every 500 ms for up to 3 s. `MacDisplayWake` reads `IOConsoleLocked` from `ioreg -n Root -d1 -a` (Root key only). Only when it reads false does it run `caffeinate -u -t 3`. A true or unreadable value never wakes anything. Each attempt writes one `display-wake` audit line: woke-ready, woke-not-ready, console-locked or unknown. The Swift helper is untouched, because moving its source hash would cost every Mac a manual macOS grant.

## Decision-point inventory

One: whether admission wakes the display. It is gated on macOS's console lock reading false. Everything else is refused as before, with the same error text.

## 1. Over-block

None added. Every case that was refused before is refused now, except an asleep, unlocked display that wakes.

## 2. Under-block

A Mac with IOConsoleLocked false but a password still needed would be woken. The flag-and-shield readiness then stays not ready, so it is still refused. Waking a display is what a person moving the mouse does, so it is no new exposure. The relock guard and the locked-screen path are untouched: a Mac whose probe is ready through the shield is never woken.

## 3. Level-of-abstraction fit

The host owns the OS reading and the wake, behind an optional `DesktopHost.wakeDisplay`, so Windows and Linux are unchanged. Admission owns when to call it: once per attempt, never in the background probe, which by design wakes nothing.

## 4. Signal vs authority compliance

IOConsoleLocked is the authority for "may we wake". The session flag stays a signal. Readiness is still decided by the same probe.

## 5. Interactions

Admission on a not-ready Mac now runs one ioreg read, up to 2 s, and on a wake up to 3 s of rereads. A really locked Mac adds one ioreg read and an audit line to each refused attempt. Under the test runner the real wake is blocked unless INSTAR_REAL_DESKTOP_HELPER_TESTS=1, so tests that build a real MacDesktopHost never wake a developer's screen.

## 6. External surfaces

The audit log gains the `display-wake` kind. The route errors are unchanged.

## 7. Multi-machine posture

Machine-local: it reads and wakes this Mac's own console.

## 8. Rollback cost

A git revert. No state or migration.

## Class-Closure Declaration

unbounded-self-action: closure n/a (negative declaration). At most one display wake per operator admission attempt, and only after the lockout and the 10 s rate limit pass. Up to 6 rereads over 3 s. No background loop and nothing that triggers itself.

## Second-pass review

An independent reviewer read 25c85d05b and found no blocking defect. A locked Mac is still refused, because readiness still needs the helper's flag to clear, or the existing shield path. Fixed after review:
- The ioreg output cap went from 256 KiB to 4 MiB. The Studio's Root plist is about 185 KB, and a larger registry would have read as unknown, so the fix would never have worked there.
- In begin(), the operator lockout and the 10 s rate limit now run before the readiness probe. A locked-out operator, or a burst of requests, can no longer wake the display.
- After a wake, the locked-feature admission refusal is read again, because the wake and rereads take seconds.
- The audit operator id in PIN mode now matches the request row (dashboard-pin plus a session hash).
- On resume, a locked-class row already marked outsideUnlockSeen is revoked before any wake.

Noted, not changed: in Telegram mode an unlocked Mac's display can light before the code is entered, which is what a person at the Mac would cause. A sleeping display that reports sessionActive true with zero displays is not woken, a limit of this fix.

## Tier

Declared Tier 1, below the gate's risk floor of 2. The floor is raised because the change adds a new exported class. The class is a two-port wrapper around one read and one wake inside existing admission. It adds no new route, config, capability surface or helper change, and it is reversible by revert. The gate records the below-floor declaration.
