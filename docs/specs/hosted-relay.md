---
title: "An optional, open-source relay: easy addresses and phone alerts, and nobody has to use it"
slug: "hosted-relay"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "hosted-relay.eli16.md"
status: "draft"
lessons-engaged: "Bounded Blast Radius; Know Your Principal; a dark guard is worse than no guard"
related-specs: "install-experience.md, owner-authentication.md"
---

**Part 3 of 3.** Requires both other parts. Standing rules from `install-experience.md` apply, especially R2 (always an independent path) and R3 (optional and open source where at all possible).

## 1. Problem

A stranger with an iPhone needs an address that works away from home, a way for the phone to find a computer, and phone alerts. Today those need a Cloudflare domain or Tailscale account, and an Apple developer key. The operator approved a hosted service on 2026-11-02, on condition that it is open source if at all possible and never required.

## 2. What it does

Open source and self-hostable by changing one address.

1. **Addresses:** a stable, relay-assigned random name routed to the agent by **TLS passthrough**. The relay reads only the server name.
   - **Connection:** the serving machine keeps an outbound connection that carries multiplexed inbound streams, authenticated by the agent's identity key, to which the name is bound, and reconnects with backoff. **One connection per name:** a connection with a higher lease epoch displaces the older one, and the loser gets a typed `displaced` signal, so a machine that has lost serving is fenced. This works behind NAT. Build or reuse is chosen at build time; the behavior is the contract.
   - **Certificate:** the agent obtains its own through ACME TLS-ALPN-01 over that path. HTTP-01 and DNS-01 are ruled out, since DNS-01 would have the relay handle validation. The agent's key stays stable across renewals so the app's pin survives. A rotation or a machine takeover uses a signed owner-record entry, and the app verifies that entry against its existing trust before sending anything to the new key.
   - **Domain:** the relay zone goes on the Public Suffix List before first deploy, for per-name certificate limits and cookie isolation. Listing takes weeks, so a CA rate-limit exemption or an issuance cap is the fallback at first deploy.
2. **Rendezvous:** one-time codes so a phone and computer can find each other. High-entropy, ten-minute life, nothing kept after use, with per-address limits on redemption. **A rendezvous code is never ownership proof.** Ownership uses the key-derived code in `owner-authentication.md` section 4.
3. **Push:** forwarding content-free alerts through the App Store key the relay holds.
   - **Identity:** the phone registers its token with the relay under a relay-issued device credential, and tells its agent that credential's id. An agent is enrolled with its identity key, shared across its machines, and can only send a signed trigger naming a device that has authorized it. The relay refuses others, so one agent can't target another's phones or spend its allowance. Triggers carry a short validity window and an idempotency id, so a replay can't spend the allowance.
   - **Revocation:** a phone's or owner's removal reaches the relay as a signed, versioned request. Authorization and token updates carry revisions, and revocation takes precedence over a reordered older grant.
   - **Content:** the relay sets the title from the registered agent name. The phone fetches details directly from the agent.
   - **Admission:** the trigger moves from "after the Telegram hub post" to a channel-independent hook after the Attention hub filter admits an event. This amends frontloaded decision 2 of `mobile-push.md`. Held items still don't notify, hub notices keep working, and cross-machine dedupe stays.

It stores no conversations and no owner authority.

## 3. Phone-first

The app offers "Create my agent". It gives the person the command to run on their computer, and rendezvous connects the two with no private address. The app doesn't start or provision a computer.

## 4. Trust limits

A relay controlling a name's DNS could obtain a certificate for it, so:

- **The app pins the agent's certificate key at pairing.** A substituted one fails loudly.
- **The browser dashboard on a relay address is view-only, and no browser page on a relay is trusted.** The legitimate server refuses all proof entry there (`owner-authentication.md` 3.1). A malicious relay could serve its own convincing page without contacting that server, so the product teaches one rule: on a relay address, secrets and approvals happen only in the app.
- **No content promise.** Passthrough forwards any TLS server, so the view-only rule is enforced by the Instar server, not the relay.
- **Certificate monitoring.** Agents compare newly logged certificates for their name against their own key. Their own renewals stay silent. Checks are deduped per certificate, and a breaker stops retries during log outages. A key mismatch is a security event and raises one item immediately.

## 5. Failure

If the relay is down, the agent keeps running, and channels and other addresses keep working. The app tries other routes first and names the relay only when all fail. A test blocks the relay at the network level and shows a self-hosted agent is unaffected.

## 6. Limits

Proposed defaults, confirmed at the operator boundary:

- One free name per owner, ten at most.
- 60 pushes per device per day, plus a per-agent ceiling enforced at the relay.
- A signed owner request removes a name. A relay operator takedown path and abuse contact exist from day one, because a name under our domain could front phishing.

## 7. Disclosed exception to independence

Apple accepts alerts for the App Store app only when signed with the key of the team that owns the app. That key can't be self-hosted, even with open relay code. Independent users keep the app, which updates when opened, and get alerts through Telegram or Slack, or build the app themselves. They are told this when they choose independence. A self-hosted relay can still provide addresses and rendezvous. It needs a domain, wildcard DNS and a public IP.

## 8. Testing and proof

- **Unit and integration:** passthrough reads no content; reconnect; code expiry and single use; one agent refused for another's device; push ceilings and durable quota; held items don't notify; certificate comparison on both sides.
- **E2E:** a substituted certificate fails at the app; the browser refuses proof entry on a relay origin; machine takeover with the old machine unavailable, and with both reconnecting.
- **Independence:** relay blocked; a self-hosted relay at a changed address.
- **Live-user-channel proof:** a stranger-shaped phone-first run.

## 9. Frontloaded Decisions

1. **Passthrough, not termination.** This avoids a separate encryption layer and keeps the relay out of the content.
2. **Dashboard on a relay address:** view-only.
3. **Open source from the first deploy,** in the Instar repository or its own public repository, chosen at build time.

**Operator boundaries.** These stop the run until the operator acts: deploying the relay with its cost ceiling, confirming the limits in section 6, and submitting to the App Store. The first two come after parts 1 and 2 are live.

## 10. Decision points touched

| Decision point | Class | Justification |
|---|---|---|
| Certificate mismatch escalates | invariant | Deterministic key comparison, security class |
| Proof entry refused on relay origins | invariant | Structural origin check |
| Push ceiling | invariant | Fixed numbers |
| Name issuance and removal | invariant | Signed owner request |

**State versus symbol.** Reachability uses the existing proof that this process answers on the name. A certificate that matches a logged entry isn't assumed to be ours until compared with our key. An unreachable log reads `unknown`, not clean.

## Multi-machine posture

| Surface | Posture |
|---|---|
| Relay name | Unified: one name per agent. Only the serving machine holds the connection. Handing over needs three amendments to `mobile-multi-route.md`: a relay-name candidate source, an arrival class for the reverse connection, and an app rule accepting a name that moved between machines of the same owner. Device authorization carries over through the owner record |
| Agent TLS key for the relay name | machine-local-justification: physical-credential-locality (a machine that takes over the name gets its own key and certificate; the app learns it through the owner record's signed entry) |
| Push tokens | Unified with the existing push fan-out across machines |

## Open questions

*(none)*

## Left behind

- Hosting provider and capacity are chosen at the operator boundary.
