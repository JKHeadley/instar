---
title: "The one-time local link from a Windows browser to an agent in WSL"
slug: identity-security-piece1g-wsl-local-link
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece1g-wsl-local-link.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "Security Fixes Keep the Experience Whole; Verify the State, Not Its Symbol; An Instar Agent Always Serves a Team"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), §4.6 (the local claim) and §12 item 1"
depends-on: "identity-security-piece1a-local-link (PR 3406): the one-time local link this extends"
lessons-engaged: "verify-the-state-not-its-symbol, a-dark-guard-is-worse-than-no-guard, no-single-device-lockout"
review-convergence: "2026-11-18T15:15:00Z"
review-iterations: 3
review-completed-at: "2026-11-18T15:15:00Z"
review-report: "reports/identity-security-piece1g-wsl-local-link-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) round 1 (first draft)"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\"), whose §4.6 specifies this acceptance, and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here."
---
# The one-time local link from a Windows browser to an agent in WSL

## Problem statement

Piece 1a gives the owner a one-time link that opens the dashboard on the same computer without the PIN. It is accepted only from a loopback peer, on the server's 127.0.0.1 socket, with no forwarding header (`localPeer`, `localAccessRoutes.ts`).

When the agent runs inside WSL (the Windows Subsystem for Linux) and the owner's browser is on Windows, the request reaches the agent in one of two ways:

1. **WSL's own localhost forwarding** (the default in NAT mode). A Windows browser opening `http://127.0.0.1:<port>/` is relayed into WSL and arrives on WSL's loopback, so piece 1a already accepts it.
2. **A Windows port proxy** (`netsh interface portproxy`) in front of WSL. The request arrives inside WSL from the Windows host's address on the WSL network: the default gateway that `wslWindowsHostAddress()` already reads. Piece 1a refuses it.

The approved umbrella (§4.6) settles how this case is treated: "On a WSL agent the CLI inside WSL mints the link and it is also accepted from the WSL gateway address, because the link's secret, not the address, is the credential. Tunnel traffic is never local."

What the gateway address does and doesn't prove, checked on the Mama PC on 2026-11-18:
- **It is not proof the request came from this computer.** That machine's port proxy listens on `0.0.0.0` for ports 4040, 2222 and 6080, so other machines on its network and the tailnet reach WSL from the same gateway address. Any Windows-side forwarder (Tailscale serve, an SSH `-L`, a tunnel client) does too, with no port-proxy rule at all.
- **The secret is the gate.** That is why the umbrella makes the secret the credential: single-use, short-lived, high-entropy, with piece 1a's challenge cap. The address check is defence in depth, and for the gateway it is weaker than loopback.

## Proposed design

### 1. Accept the exact WSL gateway as a local peer for redemption

A request counts as local for **redeeming** the link (and for the unlock check that uses it) when it passes piece 1a's loopback test, or when **all** of these hold:
- **WSL NAT mode, confirmed positively:** `wslinfo --networking-mode` answers `nat`, or, where `wslinfo` is missing, the gateway's MAC address in `/proc/net/arp` has the Hyper-V prefix `00:15:5d`. In mirrored or bridged mode the default gateway is the network's router, so if the mode can't be confirmed the gateway is not accepted. The confirmation is cached for 10 minutes.
- **The peer:** it is exactly that gateway address.
- **The socket:** the request arrived on WSL's own address for the default route, not on 127.0.0.1. The interface is named by the default route in `/proc/net/route`. The socket's local address (without `::ffff:`) must equal that interface's IPv4 address in `os.networkInterfaces()`, and the gateway must lie inside that address's `cidr`. On an agent bound only to 127.0.0.1, which is the single-machine default, the gateway never reaches the server; the link then works only through WSL's own localhost forwarding, which arrives as loopback.
- **No forwarding header,** and the `Host` header equals the ticket's origin (as in piece 1a's print mode). A Windows forward on another port works with `--port <windows port>`.
- **Rate-limited:** gateway requests to the local-access routes are capped at 30 a minute, because clients of a Windows-side forwarder can now reach them. The cap counts gateway requests only, never loopback, so forwarder clients can't use it up and block the owner's own link through WSL's localhost forwarding.
- **The secret and challenge** of piece 1a are satisfied, unchanged.

**Minting stays loopback-only.** `/mint` keeps piece 1a's loopback check, so only a program inside WSL can mint.

### 2. The command inside WSL prints the link

- **Under WSL,** `instar dashboard open` mints the link and prints it once, in a terminal only (as piece 1a's `--print`), for the owner to open in their Windows browser. `--port` names a different Windows-side port, and piece 1a's `ssh -L` hint is not shown.
- **It says how the link will travel.** Through WSL's own localhost forwarding it arrives as loopback; through a Windows port forward, from the gateway. The command never refuses to mint.

### 3. What this accepts, stated plainly

- **The residual.** A Windows-side forwarder in front of WSL (a port proxy on `0.0.0.0`, Tailscale serve, an SSH tunnel) makes the redemption route reachable from that forwarder's clients, who arrive from the gateway address. They still need the single-use secret, which exists only in this WSL's launch output.
- **Tunnels.** Tunnel traffic that arrives with a forwarding header is never local. A Windows-side tunnel without headers cannot be told apart from the owner's browser, and the secret is what protects it.
- **Another Windows account on the same computer** that binds Windows `127.0.0.1:<port>` before WSL's relay or the port proxy would be served the owner's page load, and could read the link's secret from it. This is a new residual, not piece 1a's: there, a squatter only ever got a dead link, because the agent itself held the port. Here the link is live. It is accepted under umbrella §4.6 (the secret is the credential), and it is limited to accounts already on the same Windows computer.

## Decision points touched

- **The exact WSL gateway peer counts as local for redemption** — invariant; basis: external-constraint; evidence: umbrella §4.6 ("the link's secret, not the address, is the credential").
- **It is accepted only in confirmed NAT mode, on WSL's own default-route address, with no forwarding header and the ticket's exact origin** — invariant; basis: enumerable-domain; evidence: `wslinfo` or the gateway's Hyper-V MAC, `/proc/net/route`, `os.networkInterfaces()`.
- **Gateway requests rate-limited to 30 a minute** — judgment-candidate; floor: forwarder clients cannot load the store with lookups; arbiter: Echo.
- **Minting stays loopback-only** — invariant; basis: irreversible-consequence; evidence: only a program inside WSL may create the secret.

## Multi-machine posture

The check is about this machine's own network path, so it is per machine (machine-local-justification: the forward configuration belongs to the Windows host running this WSL).

## Verify the state, not its symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
| --- | --- | --- | --- | --- |
| Local redemption under WSL | the peer address is the WSL gateway | the browser is on this computer, or a client of a Windows-side forwarder | the single-use secret and the challenge (piece 1a); the exact gateway peer on WSL's own subnet address; no forwarding header | not WSL, or the gateway unreadable: piece 1a's loopback rule only |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | On the Mama PC, with a throwaway agent in WSL on a spare port, bound to all addresses:<br>- **From Windows (gateway path):** a request carrying the printed link redeems it.<br>- **Inside WSL (loopback path):** the same works.<br>- **Without the secret:** a gateway request is refused.<br>- **With a forwarding header:** refused.<br>- **Minting from the gateway:** refused. | Discard. |
| dev-agent-live | The Mama PC's Echo. | Revert. |
| fleet | Ships with piece 1a. | Patch release. |

## Tests and evidence

- **Unit:**
  - the gateway rule, both sides of each condition: WSL or not, the exact peer, the local address on the gateway's subnet versus 127.0.0.1, a forwarding header, the Host header;
  - NAT confirmation: `wslinfo` answering nat, mirrored or missing, and the MAC fallback;
  - the default-route interface and subnet match;
  - the gateway-only 30-a-minute cap, which never counts loopback;
  - `/mint` stays loopback-only;
  - the unlock check takes the same rule.
- **Live:** the Mama PC run above.

## Maturation plan

- **ladder:** not applicable: it ships with piece 1a's link (an extension of its locality check that the approved umbrella specifies)
- **test-agent-live:** the Mama PC run.
- **dev-agent-live:** the Mama PC's Echo.
- **fleet:** with piece 1a.
- **graduation criterion:** green Local Verify, merged commit, the Mama PC run recorded.
- **dark-window:** none.

## Review rulings (round 1)

- **The first draft** proposed proving locality from the Windows port-proxy rules.
- **The internal review showed** that this can't prove locality (D1): any Windows forwarder arrives from the gateway. It also read the wrong table (D2), left the socket rule unstated (D3), and refused cases that work (D4).
- **The umbrella already decides it** (§4.6): the secret is the credential, and the gateway is accepted. This version follows the umbrella and states the residual plainly.
- **The constitution flags** (a cached check, refusing to mint) no longer apply, because there is no check and no refusal.
- **Delta:**
  - NAT mode is now confirmed positively; mirrored and bridged modes are refused.
  - The other-Windows-account residual is stated.
  - Precision: the default-route interface rule, the Host equalling the ticket's origin, `--port`, and the rate limit.

## Open questions

*(none)*

## Left behind

- WSL in mirrored networking mode, where Windows and WSL share addresses. Refused unless the request arrives as loopback; a real run decides whether more is needed.
- Native Windows agents (no WSL), which are piece 3's.
