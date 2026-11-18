# Side-Effects Review — The one-time local link from a Windows browser to an agent in WSL

**Version / slug:** `identity-security-piece1g-wsl-local-link`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2. Spec: `docs/specs/identity-security-piece1g-wsl-local-link.md` (converged in 3 rounds). It is stacked on piece 1a (PR 3406), and follows umbrella §4.6: the link's secret, not the address, is the credential.

- **`wslGatewayPeer`** (`src/core/wslLocalPeer.ts`) accepts the exact WSL gateway only when:
  - WSL is in NAT mode, confirmed by `wslinfo --networking-mode` (probed asynchronously and cached) or else by the gateway's Hyper-V MAC (`00:15:5d`);
  - the socket's local address is WSL's own default-route interface address, with the gateway inside its `cidr`.
- **`LocalAccessService.redeemPeer`** (`src/server/localAccessRoutes.ts`):
  - piece 1a's loopback rule, or the gateway with no forwarding header;
  - gateway requests are capped at 30 a minute, never counting loopback;
  - used by every local-access route except `/mint`, which stays loopback-only, and by the unlock check.
- **`instar dashboard open` under WSL** prints the link for the Windows browser. It needs a terminal, `--port` names a different Windows port, and there is no SSH hint.

## Decision-point inventory

- **Local-access route guard:** modified. The gateway peer is added for redemption; minting is unchanged.
- **Unlock local check:** modified. It uses the same redemption peer rule.

---

## 1. Over-block

None. Loopback behaves exactly as in piece 1a. Under WSL, a Windows browser through WSL's own localhost forwarding already arrives as loopback.

## 2. Under-block (accepted residuals, stated in spec §3)

- **Windows-side forwarders.** A port proxy on `0.0.0.0`, Tailscale serve or an SSH tunnel makes the redemption route reachable by that forwarder's clients, from the gateway address. They still need the single-use secret.
- **Another Windows account on the same computer** that takes Windows `127.0.0.1:<port>` first could read a live link. This is a new residual, accepted under umbrella §4.6.

## 3. Level-of-abstraction fit

One small module holds the WSL network facts, with an injectable probe. The service adds one peer rule, and the command adds one platform branch.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface for callers.
- [x] Yes — a deterministic evaluator over an enumerable domain: socket addresses, the kernel route and ARP tables, `wslinfo`'s mode, and the interface list. It sits alongside piece 1a's secret, which remains the credential.
- [ ] ⚠️ Yes, with brittle logic — STOP.

## 4b. Judgment-point check

- **30 gateway requests a minute**, counting the gateway only.
- **A 10-minute cache** of `wslinfo`.

## 5. Interactions

- **The event loop.** `wslinfo` runs asynchronously. The `/proc` reads and the interface list are cheap synchronous calls.
- **Remote desktop.** With it on, `unlockRefusedHere` (`AgentServer.ts`) refuses a gateway unlock before the local check runs. The link still redeems, and the unlock then follows the existing rules, which is safe.
- **`arrivedOverLocalTls`** has the same unconfirmed-NAT gap. It is left as it is here and noted for follow-up.

## 6. Rollback

Revert. On non-WSL systems nothing changes.

## 7. Evidence

- **Unit:**
  - `tests/unit/identity-piece1g-wsl-local-link.test.ts`: NAT confirmation, the interface and subnet match, the peer rule both ways, the gateway-only cap, WSL detection, and the mounted routes (`/mint` refuses the gateway, `/open` takes it but not with a forwarding header, and the unlock check uses the same rule);
  - piece 1a's `local-access-routes` and `local-access-store` suites.
- **Live check on the Mama PC** (`.instar/state/identity-build-144636/p1g-live-check.md`), using the real module:
  - a Windows `127.0.0.1` request arrives as loopback;
  - a Windows request to WSL's address arrives from the gateway, and `wslGatewayPeer` is true;
  - NAT is confirmed by both `wslinfo` and the MAC.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** no self-triggered action. The `wslinfo` probe runs at most once every 10 minutes, on a local-access request.
