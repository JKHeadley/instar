# Side-Effects Review — remote desktop target bootstrap

**Version / slug:** `native-remote-desktop-target-bootstrap`
**Date:** 2026-10-30
**Author:** Echo
**Second-pass reviewer:** Astra — "I concur with the corrections. No remaining blocking P1/P2 found in this static pass." Live checks remain.

The later machine-picker wording also received a second static pass. Astra
found no blocking security regression and requested uncertainty-aware wording
for absent Mac session fields; the wording was corrected before release.

## Summary and decision inventory

This repairs the installed mesh desktop rollout. The Windows companion
installer selects a Windows-owned private WSL gateway in NAT mode or loopback
in mirrored mode, then persists only that constrained address. Discovery
accepts only the currently selected address after confirming whether Windows
owns the gateway. A missing or stale persisted address fails closed. An authenticated
read-only diagnostic reports local desktop probe booleans or a sanitized
error. A target that lacks a GUI session, display, or permission remains dark.

- **Address selection:** choose a Windows-owned private gateway or loopback;
  reject public, unowned, missing, and redirected persisted addresses.
- **Old companion update:** contact the prior validated address before
  replacing its executable; a running task that cannot authenticate refuses
  replacement.
- **Readiness reporting:** expose probe signals without issuing a grant or
  reading frames; use observed Mac session fields in the machine picker and
  do not equate an agent's online state with a GUI session.

## 1. Over-block

If Windows interface enumeration fails, installation fails closed. A WSL
network mode other than NAT or mirrored may remain unavailable. A Mac helper
outside its GUI login session remains unavailable even while its agent stays
online. This change does not create a GUI login session or bypass macOS
Screen Recording and Accessibility permissions.

## 2. Under-block

A local user who already controls the Windows profile can alter the persisted
bridge address, but discovery verifies it against current Windows interfaces
and the companion still requires its 32-byte secret on each request.
The diagnostic reports only booleans, a count, and sanitized error codes;
it never returns frames, input, peer URLs, keys, or raw exception text.

## 3. Level of abstraction and authority

The address choice belongs to the WSL host adapter. The target's signed grant,
controller lock, expiry, and Stop remain unchanged. The diagnostic is a
Bearer-authenticated maintenance read, not a second desktop admission path.
The designated front remains the only browser entry point.

## 4. Signal versus authority

The Windows interface list and Mac probe are readiness signals. Neither
creates an operator session or grants input. A failed or uncertain probe
keeps the target unavailable. The address validator is a fixed transport
security boundary, not a judgment about operator intent.

## 5. Interactions and races

The existing `flock` still serializes companion replacement. Address
discovery before the lock is read-only and repeated in the lock holder; a
changed old address cannot redirect the authenticated update to an arbitrary
peer. The address file is written only after `InstallPrepared` confirms the
new task. On crash, a stale file may leave discovery dark until the next
opt-in boot; it cannot enable control. The diagnostic invokes the same
bounded host probe as admission and returns no control token.

## 6. External surfaces

`GET /desktop/diagnostics` is a new Bearer-only maintenance route on each
agent. The Windows installer may bind its companion to `127.0.0.1` rather
than the WSL private gateway. It never binds to every interface. The
Windows scheduled task is reinstalled on the next opted-in server boot, which
briefly interrupts the target during the supervised update. User flow stays
one PIN and a machine selection.

## 7. Rollback cost

Revert this package and supervised-restart the agent. Existing desktop grants
end on restart. The previous package can still read its old gateway address
and ignores the new `bridge.address` file; mirrored-mode Windows desktop may
become unavailable again. Disabling `remoteDesktop.enabled` on a target and
restarting it stops admission immediately. A Windows scheduled task can remain
installed and must be disabled separately for complete host cleanup.

## Evidence

The NAT, mirrored, missing, stale, and redirect cases have unit coverage. HTTP integration
checks Bearer protection and no target admission. The production-boot test
checks the real route wiring. Full-suite, CI Windows compile/package, and
per-host live desktop checks are release gates; none is inferred from this
review artifact. The locally built Mac helper probe returned the new session
fields on Studio with one display and existing permissions; this does not
establish Mini or M5 readiness.
