# Side-Effects Review — PIN through a WSL machine's own secure front

**Version / slug:** `console-wsl-pin-front`
**Date:** `2026-10-31`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see end)`

## Summary of the change

`src/core/desktopTransport.ts` adds `wslWindowsHostAddress()` (WSL detection via `WSL_DISTRO_NAME` or `/proc/version`; default gateway from `/proc/net/route`; cached for 60 s) and `arrivedOverLocalTls(secure, addr, forwardedProto)`. `dashboardUnlockRefused` uses it; `AgentServer` passes `x-forwarded-proto` for `POST /dashboard/unlock` and `GET /dashboard/unlock-check`. Tier 1, about 60 source LOC.

## Decision-point inventory

- PIN unlock secure-connection rule — modify (narrow widening, WSL only).

## 1. Over-block

Removes an over-block: the operator's PIN over the Mama PC's secure link was refused.

## 2. Under-block

A client reaching the Windows port proxy over plain http can forge `x-forwarded-proto: https` and be allowed to type a PIN in plaintext. That exposes only its own PIN, which it still needs, so it gains no new access. The rule exists to keep the operator's PIN off the wire, and the operator's browser never forges the header. On a WSL machine where something other than the operator's front also forwards from the Windows host, the same reasoning applies.

## 3. Level-of-abstraction fit

The rule lives in one function beside `isLoopbackPeer`, used by the unlock route and its pre-check, so they cannot disagree.

## 4. Signal vs authority compliance

The authority (unlock) keeps its PIN check. Only its transport precondition widens, on evidence.

## 5. Interactions

The desktop stream admissions (DirectDesktopAccess, WebSocketManager, the /desktop routes) keep their existing loopback/TLS rule. The WSL desktop work owns those separately.

## 6. External surfaces

None beyond the fix.

## 6b. Operator-surface quality

The PIN sheet on the Mama PC's secure link now works instead of ending in an error.

## 7. Multi-machine posture

Per machine by design: each machine decides for its own connections. The change is inert off WSL.

## 8. Rollback cost

Revert the PR.

---

## Second-pass review

Independent reviewer (subagent): the widening is safe. A forged header through the port proxy only lets the forger submit its own PIN guesses in plaintext, and the same guessing is already possible through the public https front. `trust proxy` is off, so every client on this path already shared one rate-limit bucket keyed on 172.22.96.1. That limits brute force more, but anyone on the network can use up the bucket and briefly lock the operator out of unlock. This was true before the change and is noted, not widened. WSL detection fails closed. Under WSL mirrored networking the gateway is the LAN router, which gives the same harmless "own guesses" case. The desktop routes still require TLS or loopback, so remote desktop through this front stays 403. That functional gap belongs to the WSL desktop work. Concur with the review.
