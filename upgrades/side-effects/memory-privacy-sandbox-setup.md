# Side-Effects Review — Memory privacy: install the sandbox tools at boot

**Version / slug:** `memory-privacy-sandbox-setup`
**Date:** 2026-11-04
**Author:** echo
**Second-pass reviewer:** not required

## Summary of the change

A fresh Ubuntu server has no `bubblewrap` or `socat`, so on a multi-person agent every scoped conversation got the fixed reply, as seen on nimbus. When the boot probe fails on Linux, the agent now tries `sudo -n apt-get install bubblewrap socat` before the AppArmor profile, then probes again. Also counts named people during the boot window, and makes the owner notice plain. Files: `src/core/memorySandboxProbe.ts`, `src/users/wireMemoryPrivacy.ts`, `src/users/MemoryPrivacy.ts`. A no-sandbox mode with a reply-only shell was built and dropped: a real session ran a recursive `grep` despite it.

## Decision-point inventory

None added. The existing probe still decides.

## 1. Over-block

No issue identified. It removes a block.

## 2. Under-block

A machine without passwordless sudo or without apt still gets the fixed reply and a degradation report, as before.

## 3. Level-of-abstraction fit

Same place as the existing profile step, at boot, only after the probe failed.

## 4. Signal vs authority compliance

No decision logic is added.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment points.

## 5. Interactions

Runs only on Linux, only when the probe failed. A one-person agent with a working sandbox never reaches it. It can run on a one-person agent whose sandbox is missing, which installs two small packages; `sudo -n` means nothing happens without existing rights.

## 6. External surfaces

Installs two system packages on Linux hosts where the agent already has passwordless sudo.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface changes.

## 7. Multi-machine posture

Per machine; each machine probes for itself.

## 8. Rollback cost

Revert the commit. The packages are harmless if left installed.

## Conclusion

Closes the gap found on nimbus, where a fresh server could not start the sandbox.

## Second-pass review

**Reviewer:** not required. This adds no gate, sentinel or session lifecycle logic, and only widens an existing best-effort setup step.

## Evidence pointers

First verify run stopped on unhandled errors with no named test, on a loaded machine; rerun on this head. `tests/unit/memory-sandbox-probe.test.ts`. Live on 2026-11-04: on a bare Ubuntu 24.04 server with both packages and the profile removed, the probe failed, the install and profile steps ran through `sudo -n`, and the probe then passed.
