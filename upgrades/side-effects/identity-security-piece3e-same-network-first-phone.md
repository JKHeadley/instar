# Side-Effects Review — a new agent's first phone pairs over the same network (identity A4, piece 3e)

**Version / slug:** `identity-security-piece3e-same-network-first-phone`
**Date:** `2026-11-19`
**Author:** `Echo (builder #38)`
**Second-pass reviewer:** `two independent Opus reviewers (security, integration), then an Opus resolution check; see docs/specs/reports/identity-security-piece3e-same-network-first-phone-convergence.md`

## Summary of the change

Tier 2. About 1,500 added lines in 8 new source files and 11 changed ones, plus 7 test files. Effort: two review rounds,
one commit. A new agent with no tunnel, no Tailscale and no Telegram (the Windows app's agents today) could not pair a
phone at all (`409 stable-address-required`). This adds a second HTTPS listener, closed until the owner asks at the
computer (`src/server/sameNetworkListener.ts`), with its own certificate (`src/core/SameNetworkCert.ts`), a network rule
(`src/core/SameNetworkNetwork.ts`), a gate (`src/server/phoneSetupRoutes.ts`), `arrivalOf` (`src/core/requestArrival.ts`),
a new `same-network` address kind through redeem and device signatures (`src/server/mobilePairingRoutes.ts`), the
"Add your phone" routes and a terminal command (`src/commands/mobileAddPhone.ts`), and an admission `at-computer` that
lets a first phone in for conversations only after the owner types, at the computer, the number the agent issued to that phone.

## Decision-point inventory

- Redeem eligibility (`mountPublicMobilePairingRoutes`) — modify — a third address kind, decided by the listener a request arrived on.
- `deviceAuthenticator` — modify — same-network devices only on their listener and vice versa; at-computer phones limited to the browser-device route set plus three; notify tokens refused for same-network devices.
- Approval funnel (`approveOutcome`, `approvable`, confirm route) — modify — refuses a phone whose admission is `at-computer`.
- `activeOwnerPhone` — modify — false for `approvedVia: 'at-computer'`.
- Local tests (`localBindingOk`, `sameMacHost`, `loopbackBindingOk`, `boundSetupHost`, `arrivedLocallyUnforwarded`, `/internal/` middleware) — modify — ask `mayBeLocalArrival` first.
- `sameNetworkGate` — add — allow-list floor in front of the new listener.
- `POST /mobile/phone-setup` and friends — add — local-only, PIN-gated.

---

## 1. Over-block

- An owner with an at-computer phone cannot add a second phone at the computer; they must remove the first. Intended (first phone only), and the refusal says how.
- An at-computer phone cannot use owner admin routes (org acts, grants, attention choices). Intended until piece 3b; conversations still work.
- A machine with two equal default routes reads its network as unknown and keeps the home address closed.
- Inside WSL mirrored mode the listener stays closed (no provable NAT address to bind; limit). Inside WSL NAT mode it binds WSL's own NAT address, because WSL's loopback is not reachable from Windows (found in the live proof).

## 2. Under-block

- A program on the agent's computer holding the token and able to read the PIN can start a setup (A4 limit 1).
- A network made to look like an allowed one reopens the listener; it reaches only the gate's narrow surface.
- For up to 15 s after a network change the listener keeps its old address.
- Inside WSL the network rule and per-address limit are the Windows app's pass-through's job (piece 3c).

## 3. Level-of-abstraction fit

The listener is the right owner of "what is local": the arrival is decided where the socket is accepted, not inferred
from addresses. The approval restriction sits in the two existing chokepoints (`activeOwnerPhone`, `deviceAuthenticator`)
rather than per route. The admission reuses the existing device registry, key ledger and activation order.

## 4. Signal vs authority compliance

- [x] No — this change has no judgment-based block/allow surface: every new refusal is an enumerable access-control
  floor (which listener, which device kind, which route list), like the existing own-name and loopback checks.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The network rule compares an observed tuple
(interface, router, range) with recorded ones: an invariant on an enumerable domain, failing closed when unreadable.

## 5. Interactions

- Shares the express app: every listener request passes the gate first, then the same middleware as the main listener.
- The `sn:` remote address keys rate limits per caller on the listener; every address-only loopback test answers no there.
- Boot and lease-loss expiry already lapse pending devices; at-computer pending devices follow that rule.
- The ratchet test fails on a new address-only local test; its baseline holds the pre-existing sites.

## 6. External surfaces

A new port on the LAN only after the owner asks at the computer (PIN). The pairing link gains a version 2 (QR only,
never in a chat); instar.sh/pair shows "scan the code on your computer" for it and reads nothing from it. New CLI
command `instar mobile add-phone`. New awareness entry. Phones: the iPhone/Android apps must learn v2 scanning and
pinning (piece 3c) before a real phone can use this; the stand-in phone proves the agent side.

## 7. Multi-machine posture

Machine-local by design: the listener, certificate, name and allowed networks belong to one computer's network and key.
The first phone is set up only on the lease holder; the device record stays where it paired, as today. Another machine
opens nothing unless asked at that computer (tested).

## 8. Rollback cost

Low. Nothing opens on update; absent state means closed. Kill switch `mobilePairing.sameNetwork.enabled: false`, or a
revert. Phones paired only this way then cannot reach the agent; nothing else changes. The new device fields are
optional and ignored by older builds (an older build would treat an at-computer phone as an ordinary owner phone,
which is why piece 3b's minimum-build fence matters before the mark exists).

## Second pass

Two rounds, recorded in the convergence report. Round 1 found two blockers (approval-funnel bypass; approval power) and
round 2 one more (owner admin routes); all fixed and tested. Concur after fixes, with the note that round-2 fixes were
not re-reviewed by a third round.

## Class-Closure Declaration

- **Class:** `unbounded-self-action` — **closure:** `guard` (enforcement: test).
- **Component:** `src/server/sameNetworkListener.ts` (the 15-second reconcile).
- **Citation:** `tests/integration/same-network-first-phone.test.ts`.
- **How it converges:** one reconcile per 15 s fixed interval, serialized (a tick while one runs returns the running one). Each tick converges the listener to one of two states from the stored wish and the observed network: open or closed. No retries, no spawns, no backoff loop, no notices; a tick that finds the state already right does nothing.
