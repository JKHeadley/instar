# Windows desktop loopback: side effects

## Over-block

If the Windows-local PowerShell hop is unavailable, a loopback-only companion is unreachable from WSL. The target fails its probe and stays dark. A legacy gateway address is accepted only while Windows still owns it during the update.

## Under-block

The companion listens on Windows loopback and continues to require signed, bounded requests and its single-controller lease. A local Windows process could reach that listener, but cannot authorize desktop input without the companion secret and target grant.

## Level of abstraction

This changes the companion's bind address and discovery transition. Browser admission, target grants, stream limits, input checks, and Stop are unchanged.

## Signal versus authority

A successful local probe shows the companion is reachable; it does not prove the Firewall dialog is gone or grant operator control. Live browser input and post-Stop refusal remain the readiness test.

## Interactions

The installer stages a new loopback task, requests a one-use update token from the old companion through its saved Windows-owned address, confirms the old task has stopped, then writes the new loopback address. Discovery accepts both the new loopback address and a currently Windows-owned legacy gateway. It rejects arbitrary persisted destinations.

## External surfaces

No public listener, new PIN step, credential, or firewall rule is added. Windows may still show unrelated system dialogs; Instar does not approve them.

## Multi-machine posture

Only opted-in WSL Windows desktop targets use this path. Mac hosts and the Studio front are unaffected.

## Rollback cost

Rolling back the package restores the previous installer behavior on a subsequent bootstrap. Existing loopback companions remain signed and reachable through the Windows-local transport. No secret rotation or persistent schema change is needed.

## Second-pass review

**Reviewer:** independent Windows local transport reviewer.

The first pass found a P1 repeat-install failure: WSL would try its own
`127.0.0.1` before the Windows-local fallback. The installer now starts the
signed Windows-local prepare/commit/cancel path for a loopback companion. The
reviewer concurred on the second pass, finding no remaining P1/P2 issue in
token validation, destination checks, active-session refusal, or the stopped
task gate. Live migration, repeated install, and Stop checks remain release
evidence requirements.

## Class-Closure Declaration

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence: { enforcementType: gate, citation: scripts/install-windows-desktop-companion.mjs, howCaught: the installer binds the companion only to Windows loopback and the local signed transport connects there, preventing a gateway listener from eliciting the Windows Firewall permission dialog; live Mama PC browser proof is required before calling normal control ready }`. Unit tests exercise loopback and legacy destination boundaries.
