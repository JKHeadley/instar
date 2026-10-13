---
title: Verified pairing by invite link (replaces the 12-word confirmation)
status: draft
owners: Dawn (author), Echo (review)
supersedes-ux-of: docs/specs/secure-a2a-verified-pairing.md (§3.2 human comparison, §3.6 panel)
---

# Verified pairing by invite link

## 1. Why

On 2026-10-13 Justin tried the v2 pairing (Dawn ↔ Scout) and stopped. He had to read 12 words, compare
them across two screens, then type all 12 words. The panel's timed refresh wiped his progress, and a tab
opened before an update showed no panel at all. His words: "NOT a sustainable process for human users",
and the bar for the replacement: dummy proof, **especially between agents of two different users**.

The v2 design made the human the comparison mechanism, but the server already compares. A person
should only ever **carry** something from one trusted place to another, never read or compare it.

## 2. Decisions (agreed with Justin, 2026-10-13)

- **D1. Built into Instar, not a central service.** The attack is a key swap by whoever is in the
  middle, and the party best placed to do that is whoever runs the relay (us). A code-sharing service
  run by the same party adds no protection. Invites travel only outside our infrastructure.
- **D2. Users send the invite through whatever app they already use with each other** (iMessage,
  Slack, email). That channel is theirs and is trusted for integrity between them. Confidentiality does
  not matter: the invite carries public keys plus a one-time secret that is useless after one use.
- **D3. No words to read, compare or type.** Each side gives one approval (a PIN or a Telegram tap).

## 3. The flow (what the person does)

1. **Inviter:** clicks "Invite an agent to pair" on the dashboard, or asks the agent in Telegram
   ("invite Carl's agent to pair"). They get one invite (a link and a short code; see §5).
2. **Inviter:** sends it to the other person in any app.
3. **Recipient:** gives it to their own agent: **forwards it to their agent's Telegram chat** (primary),
   or pastes it into "Accept an invite" on their dashboard. The agent answers:
   *"Pair with **Scout**, owned by **Justin**? [Approve] [Decline]"*. Recipient taps Approve.
4. **Inviter:** their agent says *"**Carl's agent** (owner: **Carl**) accepted your invite. [Finish
   pairing] [Not them]"*. Inviter taps Finish. Both agents are now `mutual-verified`.

That is one send and one tap per person, with nothing to read, compare or type.

## 4. Protocol

Notation: A = inviter's agent, B = recipient's agent. `idA`, `idB` = Ed25519 identity keys; `fpX` =
first 16 bytes of `idX` (the routing fingerprint).

**4.1 Invite.** A creates `inv = { v: 1, fp: fpA, key: idA, owner, agent, secret: S, exp }`, where
`S` = 32 random bytes and `exp` = now + 24 h. A stores `{ S, exp, used: false }` and encodes
`inv` as one base64url line with a 4-byte checksum (sha256 truncated). Truncation, a bad copy or an
edit fails the checksum and is refused loudly.

**4.2 Accept (B).** On receiving `inv`, B:
1. checks the checksum, `exp`, and that `fp == first16(key)`;
2. **machine-compares** `key` with the key the relay currently presents for `fp` (card or cache), and
   refuses on any difference (Echo's requirement (a)). A swapped or phished invite is detected, not
   pinned;
3. asks its operator to approve (§6), showing `agent` and `owner` from the invite;
4. on approval: pins `idA` as `invite-accepted` (not yet mutual), and sends A over the relay a
   `pair-invite-accept` message: `{ idB, fpB, owner, agent, nonce, tag }` with
   `tag = HMAC-SHA256(S, "threadline-invite-accept-v1" ‖ idA ‖ idB ‖ nonce)`.

**4.3 Finish (A).** On `pair-invite-accept`, A:
1. finds the open invite by trying the `tag` against unexpired, unused secrets (constant-time); no match
   means drop. The relay never saw `S`, so it cannot forge B's key;
2. checks `fpB == first16(idB)`, and that `idB` matches the relay-presented key for `fpB`;
3. marks the invite **used** (single use), then asks its operator to finish (§6), showing B's `agent`
   and `owner`;
4. on approval: pins `idB` as `mutual-verified` and sends B a signed `pair-invite-finish` carrying a
   challenge response. B verifies the signature with the pinned `idA` and flips to `mutual-verified`
   (Echo's requirement (c): possession proven both ways, not assumed).

**4.4 Credentials, receipts, restart.** Unchanged from v2: credentials encrypt to the pinned key and
its derived X25519 key, and the pinned key in the trust profile is the authority after a restart.

## 5. Getting the invite to the right agent (the "link" question)

A plain web link cannot know where the recipient's dashboard lives. The options:

| Option | Recipient does | Infrastructure | Notes |
|---|---|---|---|
| **T. Forward to own agent's Telegram** (recommended primary) | forward the message, tap Approve | none new (inline buttons exist in `TelegramAdapter`) | most agents are Telegram-bound; works on a phone |
| **P. Paste a code into own dashboard** (fallback) | copy, paste, PIN | a new "Accept an invite" box | works without Telegram |
| H. A hosted redirect page | click | a page we host | **rejected:** we would serve the code that handles the invite (D1) |

The invite is sent as one message containing both a short human sentence and the code, e.g. *"Scout
(Justin's agent) invites your agent to pair. Forward this to your agent, or paste the code in its
dashboard: `tlinv1:…`"*. The agent recognises the `tlinv1:` prefix.

## 6. Operator approval (authority)

The approval stays an **operator act, not an agent act** (v2 FD7 holds). Either of:
- a Telegram inline-button tap from the agent's **configured operator user id**. Telegram
  authenticates the callback's sender; the agent cannot press its own button as the operator. The
  callback carries an opaque one-time token bound to this invite, so a replayed or forged callback
  does nothing;
- the dashboard PIN (fallback path P).

The agent's Bearer token alone can never approve, accept or finish.

## 7. Threats

- **Key swap by the relay:** defeated twice: B compares the invite key to the relay-presented key, and
  B's reply is MAC'd with `S`, which the relay never sees.
- **Leaked invite, accepted by a stranger first:** A's operator sees the stranger's `agent`/`owner` and
  taps "Not them". Single use also means the real recipient then gets "already used", which raises the
  alarm.
- **Phished invite ("here's A's code" from an impostor):** the key doesn't match the relay-presented
  key for that fingerprint, so B refuses. An impostor using their own fingerprint shows their own
  `agent`/`owner` names, so the operator is warned by name. The one thing no design fixes is a person
  approving an agent they don't know; the screen says plainly whose agent it is.
- **Tampered message channel between the two users:** this is the trust root; D2 is explicit about it.
- **Replay:** the secret is single use and expires in 24 h; callbacks carry one-time tokens; accept
  messages carry a nonce.

## 8. UI requirements (from Justin's test)

1. Nothing in the pairing UI refreshes, re-renders or clears while a pairing or an invite is open.
2. One approval per person. The PIN is never asked twice.
3. A pending item sits at the TOP of the Threadline tab with a badge on the tab; it's never buried.
4. The dashboard notices the server version changed and offers a reload, never showing a stale page.
5. **Completion criterion:** a person (Dawn, then Justin) performs the whole flow end to end, on real
   agents, through a real reload, timing it. Passing tests is not enough
   (memory: feedback_walk_the_human_step_as_the_human).

## 9. Migration

The v2 routes stay for agents already mid-pairing, but the dashboard stops offering the 12-word flow.
Existing `pending-verification` records from v2 can be cleared or completed by invite. `mutual-verified`
pairings are untouched.

## 10. Open questions for Echo

1. Is HMAC with a 32-byte one-time secret enough here, or should the accept step be a PAKE (e.g. CPace)?
   My view: since `S` never crosses the relay and is single use, HMAC suffices.
2. Is 24 h the right expiry?
3. Telegram callback as operator authority: any path by which an agent could produce a callback that
   appears to come from the operator's user id?
