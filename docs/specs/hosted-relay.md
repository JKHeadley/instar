---
title: "An optional, open-source relay: easy addresses and phone alerts, and nobody has to use it"
slug: "hosted-relay"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "hosted-relay.eli16.md"
status: "draft"
related-specs: "install-experience.md, owner-authentication.md"
---

**Part 3 of 3.** Requires both other parts. Standing rules from `install-experience.md` apply, especially R2 (always an independent path) and R3 (optional and open source where at all possible).

## 1. Problem

A stranger with an iPhone needs an address that works away from home, a way for the phone to find a computer, and phone alerts. Today those need a Cloudflare domain or Tailscale account, and an Apple developer key. The operator approved a hosted service on 2026-11-02, on condition that it is open source if at all possible and never required.

## 2. What it does

Open source and self-hostable by changing one address.

1. **Addresses:** a stable name routed to the agent by **TLS passthrough**. The relay reads only the server name. The agent holds its own certificate and private key.
2. **Rendezvous:** one-time codes so a phone and computer can find each other. Ten-minute life, nothing kept after use. **A rendezvous code is never ownership proof.** Ownership uses the key-derived code in `owner-authentication.md` section 4.
3. **Push:** forwarding content-free alerts. The phone fetches the title directly from the agent. Eligibility no longer depends on a Telegram post: the Attention raise itself triggers it, for all channels.

It stores no conversations and no owner authority.

## 3. Phone-first

The app offers "Create my agent". It gives the person the command to run on their computer, and rendezvous connects the two with no private address. The app doesn't start or provision a computer.

## 4. Trust limits

A relay controlling a name's DNS could obtain a certificate for it, so:

- **The app pins the agent's certificate key at pairing.** A substituted one fails loudly.
- **The browser dashboard on a relay address is view-only.** Enrollment, passphrases, passkeys and recovery keys are all refused there (`owner-authentication.md` 3.1). Risky actions go to the phone.
- **Certificate monitoring.** Agents compare newly logged certificates for their name against their own key. Their own renewals stay silent. Checks are deduped per certificate, and a breaker stops retries during log outages. A key mismatch is a security event and raises one item immediately.

## 5. Failure

If the relay is down, the agent keeps running, and channels and other addresses keep working. The app tries other routes first and names the relay only when all fail. A test blocks the relay at the network level and shows a self-hosted agent is unaffected.

## 6. Limits

Proposed defaults, confirmed at the operator boundary:

- One free name per owner, ten at most.
- 60 pushes per device per day, plus a per-agent ceiling enforced at the relay.
- A signed owner request removes a name.
- Rate limits per name and owner on rendezvous.

## 7. Disclosed exception to independence

Apple accepts alerts for the App Store app only when signed with the key of the team that owns the app. That key can't be self-hosted, even with open relay code. Independent users keep the app, which updates when opened, and get alerts through Telegram or Slack, or build the app themselves. They are told this when they choose independence. A self-hosted relay can still provide addresses and rendezvous.

## 8. Testing and proof

- **Unit and integration:** passthrough reads no content; code expiry and single use; push ceilings; certificate comparison on both sides.
- **E2E:** a substituted certificate fails at the app; the browser refuses proof entry on a relay origin.
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
| Relay name | Unified: one name per agent address. The serving machine holds the connection, and handing over uses the existing route list with a live proof |
| Agent TLS key for the relay name | machine-local-justification: physical-credential-locality (a machine that takes over the name gets its own certificate; the app learns it through the owner record's signed entry) |
| Push tokens | Unified with the existing push fan-out across machines |

## Open questions

*(none)*

## Left behind

- Hosting provider and capacity are chosen at the operator boundary.
