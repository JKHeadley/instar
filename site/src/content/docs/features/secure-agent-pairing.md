---
title: Secure Agent Pairing (Verified Pairing)
description: Pair two agents by invite, so each can prove who it is talking to before any credential is shared, defeating relay key substitution.
---

Two Instar agents can already exchange encrypted, signed messages through the relay. What they could *not* do is **prove** that the agent on the other end is the one their operator actually trusts, rather than an impostor in the middle swapping keys. That gap had a concrete cost: an agent correctly *refused* to send a credential to a peer it couldn't verify. Secure Agent Pairing closes it.

It works **by invite**. One operator makes an invite and sends it to the other operator through an app they already use together. The other operator approves it, the first taps Finish, and the two agents now know each other's real keys. Nobody reads, compares or types a code.

## What it does

- **The invite travels outside the relay.** It carries the inviter's identity key and a one-time secret, and it goes through whatever the two people already use (a chat app, email, text). Whoever runs the relay never sees it.
- **The acceptor proves two things.** It holds the invite's secret (a MAC over a transcript of both keys), and it holds its own identity key (a signature). An impostor would need both.
- **Both ends check the relay.** Each side compares the key in the invite or the accept with the key the relay presents, and refuses on any difference.
- **Single use, short life.** An invite works once and expires after an hour by default (at most 24 hours). An invite made for an agent you already know is bound to it, so it is useless to anyone else.
- **A leak is caught.** If a second agent uses the same invite, the first one is paused at once (even if you already tapped Finish), you get an alarm, and the late agent is told the invite was used elsewhere.
- **Operator-approved, never self-granted.** Approving an invite and finishing a pairing are operator acts: a dashboard PIN, or a Telegram tap that provably came from the owner through the agent's own Telegram listener. The agent's own API token cannot do either.
- **A credential gate that fails closed.** A credential goes only to a verified peer, and it is encrypted to the peer's verified identity key and the encryption key derived from it, never to a key the relay handed over and never in plaintext. Any doubt refuses.
- **It follows you across machines.** A verified pairing is honored on your other machines, pinned to the peer's exact identity key.

## Using it

1. **Make an invite.** On the dashboard's Threadline tab, *Make an invite*, or ask your agent (it uses `threadline_pair` with `action: "invite"`). Copy the message.
2. **Send it privately** to the other person in any app you already use with them.
3. **They approve.** They forward it to their agent's Telegram chat and tap *Approve*, or paste it on their dashboard and approve with their PIN.
4. **You finish.** Your agent tells you who accepted (the name is what that agent *claims*). If it's who you sent it to, tap *Finish*. Otherwise tap *Not them*.

Then check `GET /threadline/pairing`: both sides show `mutual-verified`. **Never send a peer a secret until the pairing shows `mutual-verified`.** The gate enforces this, but knowing it lets you pair first instead of hitting a refusal.

The dashboard card sits at the top of the Threadline tab. Anything waiting for you is shown first and counted on the tab. The PIN is asked once per page, and nothing on the card resets while you use it.

### HTTP routes

The dashboard and `threadline_pair` drive these Bearer routes (503 when pairing is off). Routes marked PIN also need the operator's mandate PIN.

| Method | Path | Who | What it does |
|--------|------|-----|--------------|
| POST | `/threadline/pairing/invites` | inviter | Make an invite. Body: `ttlMinutes` (1-1440), optional `bindFp` to bind it to one peer |
| GET | `/threadline/pairing/invites` | either | Your invites (never their secrets), invites waiting for your approval, known peers |
| DELETE | `/threadline/pairing/invites/:iid` | inviter | Revoke an open invite |
| POST | `/threadline/pairing/invites/inspect` | recipient | Check an invite you were sent and hold it for a decision. Grants and sends nothing |
| POST | `/threadline/pairing/invites/:iid/approve` | recipient (PIN) | Approve: pins the inviter and sends the accept |
| POST | `/threadline/pairing/invites/:iid/decline` | recipient | Decline the invite |
| POST | `/threadline/pairing/invites/:iid/finish` | inviter (PIN) | Finish: pins the acceptor as verified and sends the signed finish |
| POST | `/threadline/pairing/invites/:iid/not-them` | inviter (PIN) | The acceptor is not who you meant. Nothing is pinned and the invite stays used |

## How it works under the hood

- **`PairingInvite`**: the invite format (`tlinv1:` + base64url JSON + a checksum), the transcript, the HKDF-derived MAC key, and an optional four-character check code two operators on a call can read to each other.
- **`PairingInviteStore`**: the inviter's invites in a machine-local `0600` file. The secret is deleted the moment an invite is used, cancelled or expires.
- **`PairingInviteFlow`**: the protocol. The accept goes as a plaintext relay message (the inviter can't decrypt before it knows the acceptor's key, and the accept carries no secret). The signed finish and its acknowledgement go encrypted to the pinned keys, with a bounded retry.
- **`PairingInviteTelegram`**: the Telegram surface. An invite forwarded to the agent is taken by the server before any session, log or classifier sees it, and buttons carry one-time tokens that count only from the owner, through the lifeline, while the lifeline's ingress guard enforces.
- **`AgentTrustManager`** records the result: `invite-accepted` while waiting for Finish (not credential-eligible), then `mutual-verified`.
- **`CredentialShareGate`** is the enforcement point inside the relay-send funnel. It is keyed on *who the peer is*, never on a message label or content.
- **`ThreadlinePairingReplicatedStore`** replicates only the verified result across your machines.

## The older 12-word check

Earlier versions paired by comparing 12 words on both screens and typing the other side's words. People found it too much to do reliably, so the dashboard no longer offers it. Pairings already started that way can still finish through `threadline_pair` (`start`/`status`/`verify`), and `mutual-verified` pairings made that way are unchanged.

## Safety posture

The whole feature ships **dark** behind `threadline.verifiedPairing.*` (cross-machine replication behind `multiMachine.stateSync.threadlinePairing`). When disabled, behavior is unchanged. When enabled, the credential protection is fail-closed from the first moment. It is precise about scope: it guards the sanctioned credential-sharing path, not secrets pasted into ordinary messages. The Telegram approval boundary is cooperative: it stops an agent approving with the token it normally holds, not an agent that deliberately reads its own lifeline's secret file.
