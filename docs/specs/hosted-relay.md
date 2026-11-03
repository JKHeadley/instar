---
title: "An optional, open-source relay: easy addresses and phone alerts, and nobody has to use it"
slug: "hosted-relay"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "hosted-relay.eli16.md"
status: "draft"
lessons-engaged: "Bounded Blast Radius; Know Your Principal; a dark guard is worse than no guard"
related-specs: "install-experience.md, owner-authentication.md"
review-convergence: "2026-11-02T18:36:18.506Z"
review-iterations: 6
review-completed-at: "2026-11-02T18:36:18.506Z"
review-report: "docs/specs/reports/hosted-relay-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 3
cheap-to-change-tags: 0
contested-then-cleared: 0
---

**Part 3 of 3.** Requires both other parts. Standing rules from `install-experience.md` apply, especially R2 (always an independent path) and R3 (optional and open source where at all possible).

## 1. Problem

A stranger with an iPhone needs an address that works away from home, a way for the phone to find a computer, and phone alerts. Today those need a Cloudflare domain or Tailscale account, and an Apple developer key. The operator approved a hosted service on 2026-11-02, on condition that it is open source if at all possible and never required.

## 2. What it does

Open source and self-hostable by changing one address.

1. **Addresses:** a stable, relay-assigned random name routed to the agent by **TLS passthrough**. The relay reads only the server name.
   - **Connection:** the serving machine keeps an outbound connection that carries multiplexed inbound streams, authenticated by the agent's identity key, to which the name is bound, and reconnects with backoff. **One connection per name:** the connection presents the agent's fenced serving lease (holder and epoch, issued by the mesh's lease layer, not the relay), signed by the holding machine's key from the owner record. The relay durably and atomically keeps the highest epoch and holder per name, across restarts and replicas. A higher epoch closes the older connection and its streams, sending a typed `displaced` signal when it can. A lower epoch is refused. The same epoch and holder may reconnect, and a different holder at the same epoch is refused. A buggy machine of the same owner presenting an inflated epoch is inside the mesh's own trust domain and is corrected when the mesh lease catches up. This works behind NAT. Build or reuse is chosen at build time; the behavior is the contract.
   - **Certificate:** the agent obtains its own through ACME TLS-ALPN-01 over that path. HTTP-01 and DNS-01 are ruled out, since DNS-01 would have the relay handle validation. The agent's key stays stable across renewals so the app's pin survives. A rotation or machine takeover uses a signed owner-record entry. When a pin doesn't match, the app sends no credentials or requests. It fetches only a public, narrowly scoped transition document holding the signed chain from that address, verifies it against its existing trust, and re-pins only if it verifies. This works with the old machine offline.
   - **Domain:** the relay zone goes on the Public Suffix List before first deploy, for per-name certificate limits. Listing takes weeks, so a CA rate-limit exemption or an issuance cap is the launch fallback. Instar's own cookies are host-only regardless, so isolation doesn't depend on the listing.
2. **Rendezvous:** one-time codes so a phone and computer can find each other. High-entropy, ten-minute life, nothing kept after use, with per-address limits on redemption. **A rendezvous code is never ownership proof.** Ownership uses the key-derived code in `owner-authentication.md` section 4.
3. **Push:** forwarding content-free alerts through the App Store key the relay holds.
   - **Identity:** the phone registers its token with the relay under a relay-issued device credential, and tells its agent that credential's id. An agent is enrolled with its identity key, shared across its machines, and can only send a signed trigger naming a device that has authorized it. The relay refuses others, so one agent can't target another's phones or spend its allowance. Triggers carry a short validity window and an idempotency id, so a replay can't spend the allowance. The relay also dedupes by agent, device and condition, in the same transaction as the quota count, so several machines raising one condition send one alert. URGENT items keep the existing folding exception and bypass the daily ceiling, within a separate cap.
   - **Revocation:** a phone's or owner's removal reaches the relay as a signed, versioned request. Authorization and token updates carry revisions, and revocation takes precedence over a reordered older grant.
   - **Content:** the relay sets the title from the registered agent name. The phone fetches details directly from the agent.
   - **Admission:** the trigger moves from "after the Telegram hub post" to a channel-independent hook after the Attention hub filter admits an event. This amends frontloaded decision 2 of `mobile-push.md`. Held items still don't notify, hub notices keep working, and the relay's dedupe below replaces today's per-machine suppression.

It stores no conversations and no owner authority.

## 3. Phone-first

The app offers "Create my agent". It gives the person the command to run on their computer, and rendezvous connects the two with no private address. The app doesn't start or provision a computer.

## 4. Trust limits

A relay controlling a name's DNS could obtain a certificate for it, so:

- **The app pins the agent's certificate key at pairing.** A substituted one fails loudly.
- **The browser dashboard on a relay address is view-only, and no browser page on a relay is trusted.** The legitimate server refuses all proof entry there (`owner-authentication.md` 3.1). A malicious relay could serve its own convincing page without contacting that server, so the product teaches one rule: on a relay address, secrets and approvals happen only in the app.
- **No content promise.** Passthrough forwards any TLS server, so the view-only rule is enforced by the Instar server, not the relay.
- **Certificate monitoring.** Agents compare newly logged certificates for their name against their own key. Their own renewals stay silent. Checks are deduped per certificate, and a breaker stops retries during log outages. A key the owner record doesn't authorize for that name is a security event and raises one item immediately, after a short grace for record entries still in flight. A takeover's new key is authorized by its signed entry, so it stays silent.

## 5. Failure

If the relay is down, the agent keeps running, and channels and other addresses keep working. The app tries other routes first and names the relay only when all fail. A test blocks the relay at the network level and shows a self-hosted agent is unaffected.

## 6. Limits

Proposed defaults, confirmed at the operator boundary:

- One free name per owner, ten at most.
- 60 pushes per device per day, plus a per-agent ceiling enforced at the relay.
- **After a takeover, alerts stay generic** until the phone next registers with the new machine, because the read token's verifier lives on the old one. The phone re-registers when it next opens.
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
| Connection displacement by lease epoch | invariant | Existing fenced lease, no judgment |

## State versus symbol

Reachability uses the existing proof that this process answers on the name. A certificate that matches a logged entry isn't assumed to be ours until compared with our key. An unreachable log reads `unknown`, not clean.

## Multi-machine posture

| Surface | Posture |
|---|---|
| Relay name | Unified: one name per agent. Only the serving machine holds the connection. Handing over needs three amendments to `mobile-multi-route.md`: a relay-name candidate source, an arrival class for the reverse connection, and an app rule accepting a name that moved between machines of the same owner. Device authorization carries over through the owner record |
| Agent TLS key for the relay name | machine-local-justification: physical-credential-locality (a machine that takes over the name gets its own key and certificate; the app learns it through the owner record's signed entry) |
| Push tokens | Unified with the existing push fan-out across machines |

## Maturation plan

- **test-agent-live:** a throwaway relay and test agent prove address, rendezvous, push, displacement and a substituted certificate.
- **dev-agent-live:** the development agent uses a relay name alongside its existing routes, and the operator completes a phone-first run.
- **fleet:** offered as an option in setup after the operator's deployment decision. Never a default that excludes other options.
- **graduation criterion:** 30 days of operation within the cost ceiling, with the relay-blocked independence test passing.
- **dark-window:** no code ships before the operator's deployment decision. After it, off for the fleet for at most 30 days, then a maturation item is raised.

## Open questions

*(none)*

## Left behind

- Standards gate: a phone-first start still needs a command on a computer. Accepted, because the app can't start a computer.
- Standards gate: an inflated epoch from an owner's own machine, and generic alerts after takeover, are disclosed limits in section 2 and section 6.
- Hosting provider and capacity are chosen at the operator boundary.
