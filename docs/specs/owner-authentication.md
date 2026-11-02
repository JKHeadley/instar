---
title: "Owner proof the agent can't use: signatures for risky actions, a viewing-only PIN, and the next agent by asking"
slug: "owner-authentication"
author: "echo"
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
eli16-overview: "owner-authentication.eli16.md"
status: "draft"
related-specs: "install-experience.md, hosted-relay.md"
---

**Part 2 of 3.** Builds on the owner slot in `install-experience.md`. Standing rules R1 to R7 from that spec apply, especially R2 (always an independent path) and R4 (a phone tap replaces the PIN for risky actions, and the phone is not required).

## 1. Problem

The dashboard PIN is treated as proof that a human approved something, but the agent can read it. It is six digits, reversible, per machine, gates roughly 50 routes, and returns the master API token when typed. Facts and code locations are in `install-experience.md` 1.1. Hashing it doesn't help, because the agent could crack six digits from its own stored copy.

## 2. Goals

1. Risky actions need proof the agent holds no secret for.
2. Available from a phone or a computer, with no hosted service.
3. Simple: one tap in the common case.
4. One owner across machines and agents.
5. Nobody locked out by migration, by strangers, or by a lost device.
6. The next agent or machine created by asking, with owner approval.

## 3. Owner proofs

The owner record holds public keys. Every proof produces a signature over a server-rendered action. **The agent stores no owner secret.** Pages the agent serves could capture what's typed on them, so this does not claim non-exposure for typed secrets; 3.1 limits where they're accepted.

| Proof | Key lives | Default when | Accepted from |
|---|---|---|---|
| Phone app, with Face ID | Secure Enclave | The person has the app | Any route. The app pins the agent's certificate key |
| Passkey: Touch ID, Windows Hello, security key, QR from a phone | Authenticator | An authenticator exists, on any install | Dashboard at a registered private address or loopback |
| Passphrase | Derived in the browser (Argon2id, stored salt, parameters measured on target browsers, minimum length enforced) | No authenticator exists | Same as passkey |
| Recovery key | Generated client-side, shown once | Offered at the second device or the first risky action | Recovery only |

The common case is **one tap**: a passkey at setup, with no passphrase and no recovery step during install.

### 3.1 Where proof can't happen

Relay addresses and Cloudflare quick tunnels never accept proof entry. Their operator could serve altered pages, and a captured passphrase is permanently replayable. On those origins, risky actions go to the phone or wait for a private address. This also covers Telegram-only people, as in 3.2.

### 3.2 Telegram is not proof

A bot token is readable by the agent, so a button tap can't prove a human. A Telegram-only person does risky actions from a loopback or same-network page, or adds a phone or private address, which the agent offers to set up. Existing Telegram approvals keep working until that owner enrolls a proof (section 9).

## 4. Enrollment

**With a passkey or passphrase on the machine:** the installer opens a loopback page in the browser (never printing the link in non-interactive mode). The person creates the proof. Enrollment closes after the first success.

**With a phone:** the computer shows a QR code with its address and key. Both devices show a code derived from **both** keys, at least 48 bits, as words. The person types the computer's code into the phone, and the phone signs the owner record. A copied command can't make anyone else the owner, because the installer takes no ownership parameter.

**Headless machine:** enrollment over same-network or a private address, using the phone flow or a browser on another computer with the same key-derived code. Never through a quick tunnel.

**Limit and recovery.** A local program could race the person to enrollment. So the agent's first message states when the owner was set and the key's fingerprint, and **a proof younger than 24 hours can't veto a local reset** (section 7). A stolen first-owner slot is therefore recoverable.

## 5. Approval requests

Prompts render server-canonical structured fields, and the signed challenge is the canonical action hash. The agent cannot author the wording. Each has an expiry. At most three may be pending per agent per machine, and three declines in a row pause requests and alert the owner.

**Risky actions:** approvals, money, arming, remote desktop, revoking, creating an agent, and changing the owner record. Viewing only needs a PIN session or any proof.

**Requests from a dashboard** can forward to any enrolled device, so an address without a registered passkey still works by phone.

## 6. One owner across machines and agents

- **The owner record is a trust anchor beside `identity.json`.** It never travels through ordinary state sync.
- **Structure:** a grow-only set of signed entries (add key, revoke key). Revocations always win. Disconnected machines merge deterministically, with no central authority.
- **Each signed action carries the record head the signer holds.** A machine accepts when the signature verifies against the merged set and adopts newer entries from it. No peer is needed, so a sole surviving machine keeps working.
- **New machine or agent:** an enrolled machine gives a one-time code. The approval prompt shows the new machine's key fingerprint, and the new machine's terminal shows the same words to compare. Only then is the record sent.
- **Phones across machines:** the record lists device keys, so a paired phone is accepted by all of the owner's machines. This closes the `401` on a tunnel move.
- **Honest limit on revocation:** a machine that hasn't seen a revocation would still accept that key until it syncs. Revocations are pushed to all peers with retries, and the owner sees which machines have confirmed.

## 7. Recovery

- **New device:** approved from an existing proof.
- **Lost device, with recovery key:** replaces the lost entry. This supersedes the recovery key in `MULTI-USER-SETUP-SPEC` (stored hashed, displayed by the agent, 24-hour hold), because this key is a signing key that never touched the machine.
- **Lost everything:** "Start over" on a loopback or same-network dashboard page, or a local command. **72-hour wait**, with notices on every channel at the start, at 24 hours and at 1 hour. Any proof at least 24 hours old cancels it. All audited. Never available on a relay origin. A remote operator with a closet computer uses a private address they already set up. **Physical or network access is an accepted exception to Mobile-Complete Operator Actions**: allowing it from a phone alone would let anyone reset ownership.

Owner-record change alerts, decline pauses and reset notices are security events whose arbiter is the owner, so they escalate immediately. They aren't subject to self-heal-first.

## 8. PIN changes

- One funnel, `ownerProof`, replaces all PIN-gated authority. An inventory of every consumer is a deliverable of this spec, and a lint refuses new direct PIN comparisons.
- The PIN stays for viewing only, per machine, stored as a slow hash in a worker so a burst can't block the server. The cross-machine credential is the owner proof.
- `POST /dashboard/unlock?v=2` returns only a scoped session: dashboard reads, with a fixed limit, invalidated when the PIN changes. The old response stays for one minor series so all five front-ends and the app can move, using the session-only adapter in `console/ui.js`.
- Client address comes from `CF-Connecting-IP` only on tunnel arrivals. A stronger proof bypasses the PIN limit, so strangers can't lock an owner out.
- The migrator stops re-minting a plaintext PIN. The PIN no longer goes into Telegram or LLM prompts. A forgotten PIN is reset by a proof, and until a proof exists, by the existing local path.

## 9. Migration

- `PostUpdateMigrator` moves the PIN to a hash idempotently and keeps it working.
- **Per owner:** risky actions accept the old PIN and existing Telegram approvals until that owner enrolls a proof, with a visible prompt. The first proof ends them for that owner.
- The agent offers enrollment conversationally, through a loopback, same-network or private-address page.
- **Phones paired earlier** are imported at first enrollment, signed by the new proof.
- The enrolled state has no off switch. Removing a proof is a signed record change. Approval prompts and unlock v2 have their own rollout switches before enrollment.

## 10. The next agent

The person says "make me another agent" or "put yourself on my laptop". The agent asks: "The same me on another computer, or a new helper?"

**Creating an agent is a risky action.** It needs an owner proof, shows its quota cost first, checks the machine's load verdict, and is capped per owner. A misbehaving agent can't fork helpers without the owner.

- **New helper, same computer:** the agent runs the installer with the answers file. The owner approves once, signing (ownerKey, new agent). That signature carries the sibling trust, with no invite steps. This **amends** `a2a-pairing-invite-link.md` section 11.6, whose same-owner pre-authorization covers only Finish because nothing else could prove the same owner. No agent-held key can produce this signature. Unrelated agents keep the invite flow.
- **Another computer:** the agent gives the one-liner and a one-time code, or runs it itself if it can already reach the machine (`mutual-ssh-autobootstrap.md`). The person approves per section 6 and signs in to the subscription there. Claude logins are never copied.

## 11. Honest limit

The agent runs as the same operating-system user as the code that checks signatures, so it could change the owner record or that code. This stops mistakes, confusion and casual misuse, and changes alert every proof holder. It does not defend against a deliberately hostile agent or a compromised machine. A separate user or OS-held custody is later work, and Instar 2 requires stronger custody from day one, so this section is not part of the shared contract.

## 12. Testing and proof

- **Unit and integration:** `ownerProof` per proof type; merge, revocation-wins and head adoption; concurrent changes on disconnected machines; approval text binding, pending cap and decline pause; origin refusal for proof entry on relay and quick-tunnel addresses; veto age rule; unlock v2; PIN migration with no re-mint.
- **Wiring integrity:** every migrated consumer reaches `ownerProof`; the lint fails a new direct comparison.
- **E2E:** feature-alive for each proof; sole surviving machine still accepts owner actions; phone accepted after a machine move.
- **Live-user-channel proof:** enrollment and a risky action on phone, passkey and passphrase, with no hosted service. A Telegram-only migration path.

## 13. Frontloaded Decisions

1. **Passkeys across addresses:** register per address, forward to a trusted device otherwise. Related Origin Requests deferred.
2. **Recovery wait:** 72 hours, with the 24-hour veto age.
3. **Recovery key timing:** not during install.
4. **PIN retirement:** per owner, on first proof.
5. **Unlock response:** versioned.
6. **Viewing PIN:** per machine.

No operator boundary. The `a2a-pairing-invite-link.md` amendment is a spec change the agent owns; no constitution file is touched.

## 14. Decision points touched

| Decision point | Class | Justification |
|---|---|---|
| Risky action requires an owner signature | invariant | Identity gate, verified cryptographically |
| Owner-record change requires an existing proof | invariant | Same |
| Revocation wins on merge | invariant | Deterministic safety rule |
| Proof entry refused on untrusted origins | invariant | Structural origin check |
| Recovery wait and veto age | invariant | Identity, fixed |
| Approval cap and decline pause | invariant | Fixed numbers, bounded blast radius |
| Agent creation cap | invariant | Fixed number, bounded blast radius |

**State versus symbol.** "Owner" means a signature verified against the merged record, never a name or a session. An unreadable record refuses risky actions and allows viewing.

## Multi-machine posture

| Surface | Posture |
|---|---|
| Owner record, including device keys | Unified, as a trust anchor through its own signed path |
| Approval requests | machine-local-justification: physical-credential-locality (bound to the machine holding the action; the pending cap is per machine) |
| Viewing PIN hash | machine-local-justification: physical-credential-locality (per-machine viewing credential, never replicated because a six-digit hash is crackable) |
| Dashboard sessions | machine-local-justification: physical-credential-locality (session secrets bound to the issuing machine; existing pool-link assertions cover cross-machine views) |

Single-machine agents have no replication.

## Open questions

*(none)*

## Left behind

- Argon2id parameters are set by measurement on iOS Safari and older laptops during the build.
- Backup: the owner record holds only public keys and is backed up. Private keys live on the owner's devices.
