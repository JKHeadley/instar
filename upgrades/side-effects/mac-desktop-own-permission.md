# Side-Effects Review — Mac desktop helper holds its own permission

**Version / slug:** `mac-desktop-own-permission`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent, see below`

## Summary of the change

Tier 1: a revert fully undoes it, because the inherited path remains the default
whenever the helper has no grant of its own. The helper gains an own-identity
start and a `request-permission` verb. `MacDesktopHost` probes both identities and
chooses per capability. New route `POST /desktop/request-permission`; diagnostics
gain two fields; the release build gains a fixed identifier and optional real
signing identity. Files: the Swift helper, MacDesktopHost, DesktopHost,
DirectDesktopAccess, DesktopProbeReadiness, AgentServer, routes, CapabilityIndex,
templates, the two native scripts, publish.yml, tests, docs.

## Decision-point inventory

- Desktop readiness — pass-through — still requires both permissions.
- `/desktop/request-permission` — add — a rate limit only; it holds no authority.

## 1. Over-block

A second prompt request inside a minute gets 429. The agent can retry; macOS only
shows the prompt once per binary anyway.

## 2. Under-block

An inherited grant can still vanish at a reboot on a Mac nobody has granted
directly. The diagnostics now show `inherited` so this is visible beforehand. A
stream already running keeps its identity until it restarts, and macOS revokes
live capture on its own if a grant is removed.

## 3. Level-of-abstraction fit

macOS decides by responsible process, so the fix belongs at process start in the
helper. Choosing an identity belongs in the host adapter, which owns every spawn.

## 4. Signal vs authority compliance

No brittle detector. The identity choice reads macOS's own answer per check, and
macOS remains the authority on permission.

## 5. Interactions

Every probe now starts two short helper processes. Probes run on readiness checks
and before grants, not per frame. The private call is looked up at runtime, so a
future macOS without it exits 71 and the inherited reading stands. Test fakes
ignore the variable, so they exercise the same selection path.

## 6. External surfaces

The prompt appears on the Mac's screen when the route is called, so callers are
told to use it only when someone is there. No grant, frame or path reaches the
response. CI gains three optional secrets; absent, release behaviour matches
today apart from the identifier. Changing the identifier changes the hash once;
no Mac holds a grant to the helper binary, as the Laptop's permission list shows.

## 7. Multi-machine posture

Machine-local by design: a TCC grant belongs to one Mac. Each target reports its
own state through its existing signed availability path. Windows is untouched.

## 8. Rollback cost

Revert and release. A grant left on a Mac is harmless. The hardened-runtime flag
applies only when a real identity is configured; removing the secret returns to
ad-hoc on the next release.

## Second-pass review

**Reviewer:** independent general-purpose subagent, two rounds

Round 1 raised concerns: a transient own-probe failure could revoke a live grant
and release held keys under the wrong identity, and a certificate with no identity
name would silently sign ad-hoc. Fixed: a failed own probe keeps the last reading
for 30 s, input identity is held while any input is live, release uses the
pressing identity with the other as fallback, and the workflow fails on that
misconfiguration. Round 2: Concur with the review; all three closed.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "one-shot process start and a route rate-limited to once a minute, not a self-triggered loop"}`

## Verify round

The first full verify failed three unit tests. Two were real: a stray escape left
`${port}` literal in the generated awareness text, and the new route lacked its
write-domain declaration. Both are fixed; the third, `console-mandates`, passed on
rerun without a change.
