---
title: "Threadline without Instar: verified pairing, encryption and the credential gate for any agent"
slug: "threadline-standalone-pairing"
author: "dawn"
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
status: "draft r2.1 (direction approved by Justin; Echo r1 review addressed; Dawn and instar-codey r2 drafts reconciled)"
owners: "Dawn (author), Echo (review)"
builds-on: "docs/specs/a2a-pairing-invite-link.md (the protocol, unchanged)"
eli16-overview: "threadline-standalone-pairing.eli16.md"
review-convergence: ""
review-iterations: 0
approved: false
---

# Threadline without Instar

## 1. Why

Justin, topic 61599, 2026-10-15: *"threadline should NOT require Instar. It should be a self-sufficient service/protocol that any agent can use."*

Today it does require Instar for everything that makes a channel safe for secrets. The standalone package, `threadline-mcp` (0.4.4, `packages/threadline-mcp`, depending only on the MCP SDK, `ws` and `zod`), lets any agent discover others, message, keep contacts and notes, and set a self-assigned trust label. But it:

- sends every message as **plaintext** base64 JSON (`server.ts` ~:818). Only Instar's `MessageEncryptor` encrypts (X25519 from the Ed25519 identity, HKDF, XChaCha20-Poly1305) and signs the envelope;
- has **no verified pairing**. Its `trust` field (`unknown | seen | conversed | trusted`) is set by the agent itself and proves nothing about a key;
- has **no credential gate**. Nothing refuses to send a secret to an agent whose key nobody verified.

Invite pairing (instar 1.3.1352, spec `a2a-pairing-invite-link.md`) fixed the human step, but only inside Instar. A Claude Desktop user running `threadline-mcp` cannot pair with anyone, and cannot pair with an Instar agent at all.

## 2. Decisions

**D0. The principle (Justin, topic 61599, 2026-10-15T18:51Z).** *"Instar should do what it can to further streamline the processes and optimize them, especially between Instar agents, but the fundamental requirements of agent to agent communication should be self contained in Threadline (and the external packages we develop that both Threadline and Instar use)."* So identity, pairing, encryption and the credential gate belong in Threadline's packages, and work fully without Instar. Instar's Telegram buttons, dashboard card, replication across machines and convenience routes are streamlining layered on top. They are never the only way to do something fundamental. Every later decision here follows from this, and future Threadline work should be checked against it.

**D1. One implementation, in a package with no Instar imports.** New `packages/threadline-core` holds: identity keys; the X25519 derivation and `isX25519BoundToIdentity`; the message envelope (encrypt, decrypt, sign, verify), byte-compatible with Instar's `MessageEncryptor`; the invite format, transcript, MAC key, tag and check code (today's `PairingInvite.ts`, already pure); the protocol engine (today's `PairingInviteFlow.ts`, already I/O-injected); a file-backed invite store and a pinned-key store behind small interfaces; and the credential-gate predicate. Both `threadline-mcp` and Instar depend on it. Instar keeps its own trust manager, routes, Telegram and dashboard, and calls the core for the protocol.

**D2. Wire compatibility is the acceptance test.** A `threadline-mcp` agent and an Instar 1.3.1352+ agent must pair with each other and then exchange an encrypted credential. Same envelope, same four invite ops (`pair-invite-accept|used|finish|ack`), same transcript.

**D3. The person approves through the MCP host, not through the agent.** `threadline-mcp` uses MCP **elicitation** (the server asks the host to put a question to the human and return the answer). The model cannot answer an elicitation; the host shows it to the person. It is used for the two operator acts:
- **Accept** (recipient): "Pair with the agent that calls itself X, which says it belongs to Y? Check code: K7Q2." Approve / Decline.
- **Finish** (inviter): "The agent that calls itself Z accepted your invite. Finish only if that is who you sent it to." Finish / Not them.

**D4. The recipient's invite never passes through the model.** `threadline_pair_open` takes no invite argument. It elicits "Paste the invite you were sent" from the person, so the secret goes from the person to the server and is never in the model's context, transcript or logs. An invite is never relayed either: `threadline_send` refuses any message containing one (`tlinv1:`), in every mode (D6a), because an invite works once and whoever sees it first is offered to the inviter's person.

**D5. Hosts without elicitation fall back to a terminal command, off unless the person turns it on.** If the host does not support elicitation, `threadline_pair_open` and `threadline_pair_finish` refuse. If the person has set `THREADLINE_PAIR_TERMINAL=1` in the host's config for this server, the refusal tells the agent to ask its person to run `npx threadline-mcp pair open | finish | status` in a terminal. Those commands talk to the running server over a `0600` Unix socket in the state dir, so the one running process does the pairing and the relay send. Without the variable the socket is never created and the refusal says only that this host cannot ask the person. This is a **cooperative** boundary: any process running as the same user, an agent with shell access included, can connect to the socket and approve. That is stated in the tool text and the README, the same honesty as Instar's §6.1. The commands refuse without an interactive terminal; the server never takes over a live server's socket (only a stale one is replaced), closes a connection idle for 15 minutes (the pending question is answered with nothing, so nothing is decided), and allows at most 4 connections.

**D6. Encryption is per pinned peer and never silently downgrades.** `threadline-mcp` encrypts every ordinary message to a peer whose identity key is pinned, to the X25519 key derived from the PINNED key, never to a key the relay presented. One exception keeps messages readable: an acceptor still waiting for the inviter's Finish sends as before pairing, because the inviter holds no key for it yet (a pin paused after a leaked invite stays encrypted; both sides verified it). A message that fails to verify or decrypt with the pinned key is refused, not shown as plaintext. To an unpinned peer, messages stay plaintext as today, and the sending agent is told so.

Inbound plaintext is not attributed to a pinned peer on the relay's word. On the relay path the only evidence of a plaintext envelope's sender is the relay, so plaintext arriving under a pinned fingerprint is delivered as **unverified**: labelled "claims to come from <peer>, neither encrypted nor signed, the relay could have written it", never "from <peer>", never a credential, never a pairing op other than the accept, and never answered in plaintext. (If such an envelope is signed by the pinned key it is attributed; no sender signs plaintext today, so in practice it is always unverified.) That allowance has an end: the first time a pinned peer sends us **encrypted ordinary chat**, that is recorded (`encryptedSeen`), and from then on plaintext under its fingerprint is refused outright, so a relay cannot downgrade a peer that has spoken to us encrypted. Pairing ops and credentials do not set the mark: they are always encrypted, even from Instar versions before D9 that still send ordinary chat in plaintext, so counting them would refuse every pre-D9 Instar peer's chat right after pairing. Once D9 has shipped, a newly paired Instar peer encrypts its chat from the first message, so the unverified label only covers pre-D9 senders. In v1 the mark lives in `threadline-mcp`; it moves into `threadline-core` when Instar adopts it on receive (§7 step 6).

**D6a. Listener proxy mode.** When a local Threadline listener answers on `THREADLINE_SEND_PORT` (default 7711), `threadline-mcp` sends through it and has no relay connection of its own. It then cannot pair or encrypt, so `threadline_pair_invite|open|finish` (and the terminal commands) refuse with that reason, and an ordinary message to a peer it holds a pin for is refused rather than sent through the listener in plaintext. Messages to unpinned peers go through the listener as before. Any message containing an invite (`tlinv1:`) is refused in every mode (D4).

**D7. The credential gate is in the package.** `threadline_send` gains `credential: true`. It is refused unless the peer is `mutual-verified` with a pinned key, the envelope is encrypted to the X25519 key derived from that pinned key, and the receiving side applies the same rule on ingestion. Same predicate as Instar's `CredentialShareGate`, from `threadline-core`.

**D8. A changed key is a new agent, never an automatic re-pin.** A Threadline fingerprint is the first 16 bytes of the identity public key, and a pin is valid only when `fp == key[0:16]`, so one fingerprint cannot carry two keys. A pin is never swapped: a `mutual-verified` pin refuses a different key outright, and `markInviteVerified` refuses one while any non-failed pin exists. When an agent rotates or recovers its identity (Instar `identity-recovery`), it has a new fingerprint, and to us it is an unpaired stranger: nothing carries over, sends and credentials to it follow the unpinned rules, and the only way to trust it is a fresh pairing. The old pin stays as it was, bound to the old key, and keeps refusing anything not signed by that key. `threadline_pair_status` flags an unpinned agent that claims the display name of a pinned one ("claims the name of <peer>, different key, not paired"), so the person sees a rotation rather than a stranger with a familiar name. Removing the old pin is an explicit person act: `threadline_pair_forget` asks the person through elicitation (Unpair / Keep), because forgetting a pin removes the always-encrypt rule and the credential right for that agent; the agent cannot do it alone. (`threadline_pair_cancel` only revokes an open invite.) Instar's one-identity-across-machines keeps one key across an agent's machines, so it does not trigger this.

**D9. Instar always encrypts ordinary chat to a mutual-verified peer, using the pinned key.** Today Instar 1.3.1352 encrypts ordinary chat only when the relay hands it the peer's X25519 key. After this step, for a peer that is `mutual-verified` through an invite pairing, Instar encrypts every ordinary message to the X25519 key derived from the PINNED identity key, regardless of what the relay offers, and never sends that peer plaintext. If the envelope cannot be built (no pinned key, a key that fails `isX25519BoundToIdentity`, any encryption error), the send is refused with the reason; it never falls back to plaintext. If the peer cannot decrypt, that is the peer's refusal (D6), surfaced to Instar as a failed delivery, and Instar does not retry in plaintext. Peers paired by the older SAS method keep the previous rule, because they may run a version before 1.3.1345, which cannot decrypt to a pinned key without a cached one; both sides of an invite pairing run 1.3.1352 or later. **Multi-machine, open for review:** the pairing replicated to an agent's other machines (FD11) carries five fields and arrives there as `identity-verified`, with no record of whether it was an invite or an SAS pairing. A standby machine therefore cannot tell that D9 applies, and as built it keeps the previous rule for those peers. That is safe (nothing is sent that the peer cannot read), but it is not yet "always encrypted" from a standby. Closing it means adding the pairing method as a sixth replicated field, so a standby encrypts with the same pinned key; that changes the replicated-store schema and is proposed, not assumed (§8.2). This changes Instar's behaviour, so it ships as its own rollout step (§7 step 5) behind this spec.

**D10. `threadline-core` is published on its own to npm, from `main` only.** It is a separate package (`threadline-core`, public, MIT), published by `.github/workflows/publish-threadline-core.yml`:
- **Trigger:** a push to `main` that touches `packages/threadline-core/**`, or a manual `workflow_dispatch`; the job runs only when `github.ref` is `refs/heads/main`, so a manual run on any other branch publishes nothing. Never `pull_request`, so a fork or PR cannot publish. Commits whose message contains `[skip ci]` are skipped.
- **Who can cause a publish:** only someone who can land a commit on `main` (branch protection plus review) or run a workflow with repo write access.
- **Tokens:** the `NPM_TOKEN` repository secret for `npm publish`; `RELEASE_TOKEN` only to push the version-bump commit; `id-token: write` for provenance.
- **Provenance:** `npm publish --provenance --access public`, so every version links to the workflow run and commit that built it.
- **Version:** the job builds and runs the package's tests first. If `package.json` equals the published version it bumps the patch and commits the bump with `[skip ci]`; otherwise it publishes `package.json`'s version as is. The first publish is `0.1.0` and is permanent.
- **Order:** a `threadline-mcp` release that depends on `threadline-core` waits until that version is on npm.

## 3. The protocol

Unchanged from `a2a-pairing-invite-link.md` §4: invite fields, 1 h default and 24 h max expiry, binding by default for a known peer, the HMAC-and-signature accept, the signed finish and ack, the second-accept response (one alarm and one demotion per invite), and K kept only until `exp`. This spec moves code. It does not change the protocol.

## 4. `threadline-mcp` tools added

| Tool | Who | Operator act? | Notes |
|---|---|---|---|
| `threadline_pair_invite` | inviter | no | `{ for?: <known contact or fingerprint>, ttlMinutes? }`. Returns the invite message for the person to send privately. The inviter's own secret is in the inviter agent's context, as in Instar's MCP `invite` action. |
| `threadline_pair_open` | recipient | yes (elicitation) | Elicits the pasted invite (D4), checks it, then elicits Accept/Decline (D3). On Accept, pins the inviter as `invite-accepted` and sends the accept. |
| `threadline_pair_finish` | inviter | yes (elicitation) | Lists accepts waiting; elicits Finish / Not them for one. |
| `threadline_pair_status` | either | no | Pairings, open invites, waiting decisions, leak alarms. Never the secret or K. |
| `threadline_pair_cancel` | inviter | no | Revokes an open invite. |
| `threadline_pair_forget` | either | yes (elicitation) | Unpairs from an agent after the person confirms (D8). |

Inbound invite ops are handled by the server's relay listener, never surfaced to the model as messages. Events (accept arrived, paired, leak alarm) are recorded in the state dir and reported by `threadline_pair_status` and in `threadline_inbox` as system lines, not as agent messages.

## 5. Storage (state dir, all `0600`)

`identity.json` (existing), `pairing-invites.json` (the store from Instar, same semantics), `pinned-keys.json` (fp → identity key, state, verifiedAt, pairingId, via), `threadline/encrypted-chat-peers.json` (the D6 `encryptedSeen` mark: fp → first time), `pair.sock` only while terminal pairing is on (D5), and `threadline/pairing-audit.jsonl` (pairing events, refusals, credential sends and receipts; bounded and rotated at 1 MB; never a secret or K). `threadline_pair_status` names the audit file, and `threadline_inbox` shows the newest pairing events as plain `pairing` lines. The existing contacts file keeps its `trust` label, but it no longer counts for anything security-relevant. Only `pinned-keys.json` does.

## 6. Threats (what changes outside Instar)

- **The model is not the operator.** Elicitation is the boundary: the agent can call `threadline_pair_open`, but only the person can answer it. In the D5 fallback, the boundary is cooperative, and that is said plainly.
- **The invite in context.** The recipient side keeps it out (D4). The inviter side cannot (the person needs the text). Single use, a short TTL and binding limit the damage, and so does the second-accept alarm.
- **Downgrade and injection by the relay.** We never send plaintext to a pinned peer (D6, D9), and plaintext that arrives under a pinned fingerprint is never attributed to that peer, and is refused once the peer has spoken encrypted (D6). Before pairing there is no encryption, and the tool text says so.
- **Key rotation and look-alikes.** A new key is a new agent (D8). The risk is a person re-pairing with a stranger who borrowed a familiar name; status says "claims the name of <peer>, different key", and the pairing screens say the names are claimed, not checked.
- **Mixed versions.** An old `threadline-mcp` cannot pair. It only sees plaintext from agents that have no pinned key for it, which is today's behaviour.

## 7. Rollout

1. `packages/threadline-core`, with its own unit tests ported from Instar's (invite, store, flow, envelope compatibility vectors generated by today's `MessageEncryptor`).
2. `threadline-mcp` 0.5.0 on it: the tools in §4, encryption and the downgrade rules (D6), listener proxy mode (D6a), the gate (D7), the terminal fallback (D5) and the audit log. E2Es with an in-process relay: the built `threadline-mcp` over stdio pairs with an Instar agent built by `bootstrapThreadline` and sends it a credential; the standalone module pairs with Instar in both directions; the built server through a fake local listener refuses to pair or to send a paired agent plaintext.
3. Instar switches its imports to `threadline-core` in a behaviour-identical PR. Its existing pairing tests are the check.
4. A person walks the flow in Claude Code with `threadline-mcp`, pairing with an Instar agent (the completion criterion, as §8.5 was for Instar). On a machine running a Threadline listener, `THREADLINE_SEND_PORT` must point at an unused port so `threadline-mcp` has its own relay connection (D6a).
5. Instar encrypts ordinary chat to invite-paired, mutual-verified peers with the pinned key (D9). Built and held until this spec is approved. Tests: on a real relay with both key caches cleared, a message sent before Finish still arrives, and after Finish both directions are encrypted; an SAS-paired peer keeps the previous rule; a resolver key that does not belong to the recipient, or a resolver that throws, is ignored; the resend flag survives. Standby behaviour follows the answer to §8.2.
6. Instar's receive side adopts the D6 `encryptedSeen` mark, and the mark moves into `threadline-core`.

## 8. Questions for review

1. Is elicitation support in the hosts we care about (Claude Desktop, Claude Code) reliable enough to make D5 the rare case? A sub-agent's reading of Claude Code's documentation found that Claude Code shows an elicitation request as a dialog and waits for the person; Claude Desktop is unconfirmed. The walkthrough (step 4) settles Claude Code.
2. D9 on a standby machine: should the replicated pairing record carry the pairing method (`invite` or `sas`), so a standby applies D9 with the same pinned key?

## 9. Later

- **Pre-pairing encryption (`e2e-v1`).** Encrypting to a relay-presented key before pairing would protect against passive reading by the relay operator, not against the relay itself. It needs a capability flag on the relay card and is deferred; nothing in v1 depends on it.
