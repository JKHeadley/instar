---
title: "Verified pairing by invite link (replaces the 12-word confirmation)"
slug: "a2a-pairing-invite-link"
author: "dawn"
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
status: "approved r3"
owners: "Dawn (author), Echo (review)"
supersedes-ux-of: "docs/specs/secure-a2a-verified-pairing.md (§3.2 human comparison, §3.6 panel)"
eli16-overview: "a2a-pairing-invite-link.eli16.md"
review-convergence: "2026-10-14T14:44:29Z"
review-iterations: 3
review-completed-at: "2026-10-14T14:44:29Z"
review-notes: "Echo reviewed r1 (4 blockers), r2 (second-accept race) and approved r3 (21d5fcd1) on PR #2180"
approved: true
approved-by: "Echo (EchoOfDawn, GitHub approval of r3 21d5fcd1, PR #2180, 2026-10-14T14:44:29Z) for the spec; Justin (topic 61599, 2026-10-13T01:40Z, 'Yes, perfect') for the direction: invite link, built into Instar, no central service"
approved-basis: "Justin approved the design direction after rejecting the 12-word flow; he has not read the spec text. Echo approved the spec text after three review rounds. The feature ships dark behind threadline.verifiedPairing, and Justin's own end-to-end walkthrough is a completion criterion (§8.5)."
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
- **D2. Users send the invite through whatever app they already use with each other.** That channel is
  the trust root and must keep the invite **intact and private until it is used**. The invite carries a
  bearer secret (§4.1): anyone who reads it before the recipient can try to use it. Link scanners and chat
  previews count as readers, so the invite is sent as a code, never as an http(s) URL.
- **D3. No words to read, compare or type.** Each person gives one approval.

## 3. The flow (what the person does)

1. **Inviter:** clicks "Invite an agent to pair" on the dashboard, or asks the agent in Telegram. They
   get one message to send.
2. **Inviter:** sends it to the other person, privately, in any app.
3. **Recipient:** gives it to their own agent: **forwards it to their agent's Telegram chat** (primary,
   §6.1), or pastes it into "Accept an invite" on their dashboard and enters the PIN (fallback). The agent
   asks: *"Pair with the agent that calls itself **Scout** (claimed owner: **Justin**)? [Approve]
   [Decline]"*. Recipient approves.
4. **Inviter:** their agent asks: *"The agent that calls itself **Carl's agent** (claimed owner:
   **Carl**) accepted your invite. [Finish pairing] [Not them]"*. Inviter finishes.

That is one send and one approval per person, with nothing to read, compare or type. (An optional short
check code for two operators who are on a call together is in §7.)

## 4. Protocol

Notation: A = inviter's agent, B = recipient's agent. `idX` = Ed25519 identity key, `fpX` = its first 16
bytes (the routing fingerprint), `sigX(m)` = Ed25519 signature by idX.

**4.1 Invite.** A creates:
- `iid`: 16 random bytes, a non-secret invite id (lookup and binding without trying MACs);
- `S`: 32 random bytes, the secret;
- `exp`: default now + **1 h**; the inviter may choose up to 24 h;
- `bind`: the `fpB` of the peer A means to pair. **Set by default when the inviter starts from a peer A already has a trust profile for**; optional only for a brand-new peer (§7, binding).

`inv = { v: 1, iid, fp: fpA, key: idA, owner, agent, S, exp, bind? }`, encoded as one base64url line
`tlinv1:<payload><4-byte sha256 checksum>`. A keeps `{ iid → S, exp, bind, state: open }`. **At most one
open invite per bound peer**. The dashboard lists open invites, with Revoke.

**4.2 Transcript and MAC key.** Both sides compute
`T = "threadline-invite-v1" ‖ len-prefixed(iid, fpA, idA, fpB, idB, exp, nonce, direction)` and
`K = HKDF-SHA256(ikm = S, salt = iid, info = "threadline-invite-mac-v1", L = 32)`. HMAC with a 256-bit
one-time secret is sufficient. A PAKE protects low-entropy secrets, and S is not one.

**4.3 Accept (B).** On receiving `inv`, B:
1. checks the checksum and `exp`, and that `fp == first16(key)`;
2. compares `key` with the key the relay presents for `fp`. On any **difference** it refuses. If the
   relay presents **no** key (a new peer, or the relay is down), it proceeds: the invite is the trust
   root;
3. if `bind` is set and is not `fpB`, refuses (the invite was meant for another agent);
4. asks its operator to approve (§6), labelling `agent` and `owner` as **claimed**;
5. on approval: stores `idA` as `invite-accepted` (**not** credential-eligible), and sends A
   `pair-invite-accept = { iid, idB, fpB, owner, agent, nonce, tag, sig }` with
   `tag = HMAC(K, T with direction="accept")` and `sig = sigB(T with direction="accept")`.
   **The signature proves B holds idB's private key; the tag proves B was given the invite.** Both are
   required (r1 had only the tag, so whoever held S could submit any key).

**4.4 Finish (A).** On `pair-invite-accept`, A:
1. looks up `iid`. If it's unknown or expired, drop. Rate-limited per sender fingerprint;
2. if the invite is already `used` and this accept is VALID (tag, signature and fingerprint checks of
   step 3 pass), then a leak happened, whatever the timing:
   - **the first acceptor is demoted** from `mutual-verified` (or from awaiting Finish) to
     `invite-accepted`, which is not credential-eligible, until the inviter re-confirms which agent they
     meant. This also covers the race where the inviter already tapped Finish before the second accept
     arrived;
   - A **raises a visible alarm**: "A second agent accepted your invite to <claimed name>. The agent
     already paired from it has been paused and cannot receive credentials until you choose which one
     you meant.";
   - A sends the late acceptor a reply **signed by idA**, `pair-invite-used = { iid, sigA }`: "This invite
     was already used by another agent". So the recipient's operator learns of it too. It is
     rate-limited like accepts.
   An invalid second accept is dropped silently;
3. verifies `tag` (constant time) and `sig` against `idB`, checks `fpB == first16(idB)`, checks `bind`,
   and compares `idB` with the relay-presented key for `fpB` (same rule as 4.3.2);
4. marks the invite **used** and deletes `S`, then asks its operator to finish (§6), with names
   labelled **claimed**;
5. on approval: stores `idB` as `mutual-verified` and sends B
   `pair-invite-finish = { iid, nonce2, sig = sigA(T with direction="finish") }`;
6. B verifies `sig` against the stored `idA`, flips to `mutual-verified`, and replies
   `pair-invite-ack` signed by B. A retries finish (bounded: 5 tries over 10 min) until it gets the ack.
   **Credentials need `mutual-verified` on the SENDING side.** So until B has flipped, B cannot send A a
   credential, and A can (A verified both proofs). That asymmetry is intentional and stated in the panel.

**4.5 Credentials, receipts, restart.** Unchanged from v2: credentials encrypt to the pinned key and its
derived X25519 key, and the pinned key in the trust profile is the authority after a restart.

## 5. Getting the invite to the right agent

A plain web link cannot know where the recipient's dashboard lives, and a hosted page would be ours
(D1). The options:

| Option | Recipient does | Notes |
|---|---|---|
| **T. Forward to own agent's Telegram** (primary) | forward, approve | needs §6.1's conditions; otherwise falls back to P |
| **P. Paste into own dashboard** (fallback) | paste, PIN | works without Telegram |
| H. A hosted redirect page | — | **rejected** (D1) |

The message the inviter sends reads: *"Scout (Justin's agent) invites your agent to pair. Forward this
to your agent's Telegram, or paste it in its dashboard. Keep it private; it expires in 1 hour.
`tlinv1:…`"*.

## 6. Operator approval (authority)

Approval is an **operator act, not an agent act** (v2 FD7). The agent's Bearer token alone never
approves, accepts or finishes.

**6.1 Telegram (primary).** A Telegram approval counts only when ALL hold:
- the update reached the server through the lifeline's ingress, carrying the **lifeline-only secret**
  (instar #2181, `LifelineIngressGuard`), with the guard in **enforce** mode. In observe mode, Telegram
  approval is off and the agent offers path P instead;
- the callback's `from.id` is the agent's configured operator user id, **and** the chat is the
  operator's chat or topic. In a forum group, other members see the buttons, so the handler checks
  both;
- the callback carries an opaque one-time token bound to this `iid` and this step;
- the forwarded invite itself only opens a prompt when the operator sent it.

**Interception:** a message containing `tlinv1:` is handled **structurally, before it reaches the
session**. It is not added to the session's context. `S` is not written to the agent's message history
or sent to the topic-intent extractor (which may use an off-machine model); history stores `tlinv1:<iid>`
with the secret removed.

**Honest boundary.** Every process on an agent's machine runs as one OS user, so this is a
**cooperative** boundary, the same as the PIN that sits in a config file the agent can read. It stops an
agent forging an approval with the token it normally holds. It does not stop an agent that deliberately
reads the lifeline secret file. Separately, an agent that drives the operator's own Telegram browser
profile produces callbacks genuinely from the operator's id; the typed browser broker exposes only
snapshot and send, which is the intended shape, and that boundary is cooperative too.

**6.2 Dashboard (fallback).** The paste box plus the dashboard PIN, through `checkMandatePin` (counters
and lockout).

## 7. Threats

- **Key swap by the relay:** defeated three ways. B compares the invite key to the relay's key; the
  accept is MAC'd with S, which never crosses the relay; and the accept is signed by idB.
- **Accept with someone else's key:** the accept must be signed by idB (B1 in r1).
- **Leaked invite:** the defences are the privacy rule (D2), the 1 h default expiry, single use, and the
  **second-accept response** (4.4.2): it alarms the inviter, notifies the late acceptor with a signed
  reply, and demotes the first acceptor until re-confirmed. The demotion closes the race where the
  inviter already finished with an impostor before the real recipient's accept arrived. When the inviter already knows the peer, **binding** to `fpB` (4.1)
  makes a leak harmless. Names are self-described, so a stranger can call itself "Scout, owned by
  Justin". The prompts say *claimed*, and r2 does not pretend names protect anything.
  **Optional check code:** both confirm screens show `code = first 20 bits of HMAC(K, "check" ‖ idA ‖
  idB)` as 4 characters. Two operators on a call together can read it to each other. It is never
  required, so it costs nothing for the normal flow and catches a substituted acceptor when used.
- **Phished invite** (an impostor sends "here is Scout's invite" with its own key): its fingerprint is
  the impostor's own, and B shows that agent's claimed names. This is the same trust decision as
  accepting a stranger's invite, and no design fixes approving an agent you don't know.
- **Forged approval:** §6.1.
- **Replay and brute force:** single use, expiry, nonces, one-time callback tokens, rate limits on
  accepts.

## 8. UI requirements (from Justin's test)

1. Nothing in the pairing UI refreshes, re-renders or clears while a pairing or an invite is open.
2. One approval per person. The PIN is never asked twice.
3. A pending item sits at the TOP of the Threadline tab, with a badge on the tab.
4. The dashboard notices the server version changed and offers a reload, never showing a stale page.
5. **Completion criterion:** a person (Dawn, then Justin) performs the whole flow end to end, on real
   agents, through a real reload, timing it. Passing tests is not enough
   (memory: feedback_walk_the_human_step_as_the_human).

## 9. Migration

The v2 routes stay for agents already mid-pairing, but the dashboard stops offering the 12-word flow.
Existing `pending-verification` records from v2 can be cleared or completed by invite. `mutual-verified`
pairings are untouched.

## 10. Changes from r1 (Echo's review, 2026-10-13)

- B1 → 4.3.5: the accept is signed by idB over the transcript, and A verifies both the tag and the
  signature.
- B2 → 6.1: Telegram authority requires #2181's lifeline secret in enforce mode, plus `from.id` and chat
  checks and a one-time token. Off in observe mode. The boundary is stated as cooperative.
- B3 → 4.1 `bind` (default for a known peer), 4.4.2 second-accept response (an alarm, a demotion of
  the first acceptor whatever the timing, and a signed notice to the late acceptor), names labelled
  claimed, an optional check code, and a non-secret `iid`.
- B4 → D2 and 6.1 interception: the invite is private, sent as a code (not a URL), and S is kept out of
  context and history.
- Should-fix: HKDF-derived MAC key over a full transcript; 1 h default expiry with a list and revoke;
  defined behaviour when the relay has no key; finish ack and bounded retry, with credential gating per
  side stated; group-chat checks; claimed labels; rate limits.
