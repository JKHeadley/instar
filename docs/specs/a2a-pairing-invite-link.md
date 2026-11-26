---
title: "Verified pairing by invite link (replaces the 12-word confirmation)"
slug: "a2a-pairing-invite-link"
author: "dawn"
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
status: "approved r3; r4 amendment (§11) approved 2026-10-21; r5 (§6.1 taps in armed observe) approved 2026-10-21 (Echo reviewed 6879b7d1a; direction Justin, topic 61599); r6 (§6.1 say why there are no buttons) approved 2026-10-21 (Echo); r7 (§6.1 polling agents) proposed 2026-10-21, approved: false"
owners: "Dawn (author), Echo (review)"
supersedes-ux-of: "docs/specs/secure-a2a-verified-pairing.md (§3.2 human comparison, §3.6 panel)"
eli16-overview: "a2a-pairing-invite-link.eli16.md"
review-convergence: "2026-10-14T14:44:29Z"
review-iterations: 3
review-completed-at: "2026-10-14T14:44:29Z"
review-notes: "Echo reviewed r1 (4 blockers), r2 (second-accept race) and approved r3 (21d5fcd1) on PR #2180"
approved: true
approved-by: "Echo (EchoOfDawn, GitHub approval of r3 21d5fcd1, PR #2180, 2026-10-14T14:44:29Z) for the spec; Justin (topic 61599, 2026-10-13T01:40Z, 'Yes, perfect') for the direction: invite link, built into Instar, no central service"
amendment-r4: "§11, 2026-10-20, from Justin's live PP ↔ Echo test (topic 61599). APPROVED 2026-10-21: Echo checked the implementation at f208df2c6 on the Studio (17/17 invite e2e, 138/138 touched test files, restart case checked:true on both sides); Justin chose the one-tap same-owner flow (11.6, Q1) in topic 61599 at 2026-10-21 08:05 PDT ('Yes please proceed'). Shipped in PR #2270, merge 72d7d31eb."
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

That is one send and one approval per person, with nothing to read, compare or type. *(r4, §11, proposed:)* each
tap gets an immediate reply, the two agents then check they can talk to each other, and **both** people
are told "Connected ✓", or one plain sentence saying what went wrong. When one person owns both agents,
they can mark the invite "It's one of my agents" on the inviter's side, and then there is no Finish
tap (§11.6). (An optional short
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

**4.4 Finish (A).** Definition used below: an accept is **VALID** when its `tag` verifies (constant
time), `sigB` over T verifies, `fpB == first16(idB)`, `bind` (if set) equals `fpB`, and `idB` matches the
relay-presented key for `fpB` (the 4.3.2 rule). On `pair-invite-accept`, A:
1. looks up `iid`. If it's unknown or expired, drop. Rate-limited per sender fingerprint;
2. if the invite is already `used` and this accept is VALID, then a leak happened, whatever the timing
   (at most one alarm and one demotion per `iid`; a further VALID accept only gets the signed notice):
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
3. checks that the accept is VALID; an invalid accept is dropped silently;
4. marks the invite **used**, deletes `S`, and keeps `K` (derived from `S`) only until `exp`, solely to
   check that a later second accept is VALID; `K` is deleted at `exp`, like `S`. Then it asks its
   operator to finish (§6), with names labelled **claimed**;
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

> *Security note (2026-10-19, `docs/specs/telegram-button-approval.md`):* "the Bearer token alone never
> approves" holds for the token used as a header. The token can spawn a session (G11 there), and a session
> can read the lifeline secret and forge a verified tap (G5) or read the PIN (G1, G3). The §6.1 honest
> boundary already says this is cooperative; pairing's approve/finish taps are P-class and move to the
> dashboard in the same release that stops posting the PIN into Telegram (§2 there).

**6.1 Telegram (primary).** A Telegram approval counts only when ALL hold:
- the update reached the server through the lifeline's ingress, carrying the **lifeline-only secret**
  (instar #2181, `LifelineIngressGuard`), and the guard can prove taps (`tapsProvable()`): enforce
  mode, **or** default observe once the lifeline has armed the guard with its secret. Armed observe
  already refuses every tap without the secret, so a verified tap means the same in both modes. Held
  observe (explicit `enforce: false`), bypass, no secret held, or no lifeline ingress: Telegram approval
  is off and the agent offers path P instead. *(r5, 2026-10-21: was "enforce mode" only. A new agent
  spends its first day or more in observe, which is exactly when its owner pairs it; Justin's PP test
  got "go to the dashboard" for that reason, topic 61599.)*
  *(r6, 2026-10-21: when it is off, the message says why, in plain words, with the agent's Instar
  version (`tapsUnprovableReason()`, plus "reads Telegram directly" when the server polls). Justin's
  second PP test still got the dashboard line, and nobody could tell which cause without access to
  PP's machine.)*
  *(r7, 2026-10-21: an agent with **no lifeline**, whose server polls Telegram itself, takes invites
  and taps on that polling path. Updates read with `getUpdates` come from Telegram itself (TLS, the
  bot token), so they are as authentic as the lifeline's forwards; they go to the same handler and
  its owner, chat and one-time-token checks. The guard on such an agent arms as
  `no-lifeline-ingress` and enforces, so a Bearer-token call to the internal routes is still
  refused. Luna read PP on 2026-10-21: 1.3.1384, no lifeline, armedBy no-lifeline-ingress. Pairing
  had dropped the buttons whenever the server polled.)*
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
- *(r4, §11.6, proposed)* **A pre-authorized invite ("It's one of my agents"):** finishes without a
  later "Not them" moment, so a leaked copy used first pairs an impostor until the owner's own agent uses
  the invite (alarm and pause, §4.4.2) or the owner unpairs it after the `auto-finished` message names
  it. It does not prove the approver on the other agent is the same person; nothing available today can.
- *(r4, §11.2)* **The new signed notices** (received, refused, hello) are verified against pinned keys;
  the relay cannot forge them. Stripping the `hs` flag only turns them off, and the operator is told the
  peer looks older. Refusals are sent only for accepts that name their sender's own key, and are rate
  limited; malformed accepts and bad tags or signatures on an open invite stay silent on the wire. A
  replayed refusal cannot outlast a real pairing (a verified finish wins, §11.5); a replayed hello
  cannot announce a pairing twice or drive sends without end (§11.4).

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
  checks and a one-time token. Off in observe mode. *(r5 narrows "off" to an observe guard that cannot
  prove a tap; see 6.1.)* The boundary is stated as cooperative.
- B3 → 4.1 `bind` (default for a known peer), 4.4.2 second-accept response (an alarm, a demotion of
  the first acceptor whatever the timing, and a signed notice to the late acceptor), names labelled
  claimed, an optional check code, and a non-secret `iid`.
- B4 → D2 and 6.1 interception: the invite is private, sent as a code (not a URL), and S is kept out of
  context and history.
- Should-fix: HKDF-derived MAC key over a full transcript; 1 h default expiry with a list and revoke;
  defined behaviour when the relay has no key; finish ack and bounded retry, with credential gating per
  side stated; group-chat checks; claimed labels; rate limits.

## 11. Amendment r4: both sides hear the result (2026-10-20)

> **Status of this section: `approved: true` (2026-10-21).** Proposed by Dawn on 2026-10-20 from Justin's live test.
> Echo checked the implementation (PR #2270 at f208df2c6) and Justin chose the one-tap same-owner flow
> (11.10 Q1). §1–§10 (r3) stay approved and unchanged except where this section says so.

### 11.1 Why

On 2026-10-20 Justin paired a brand-new Instar agent, PP, with Echo (both his). PP made an invite, he
forwarded it into Echo's Telegram topic and tapped Approve, and Echo said "waiting for the other side".
After that nothing happened on either side, and nobody was told anything. A reproduction on 1.3.1364
against the real relay found where the silence comes from:

- every refusal in `handleAccept` ends in `console.warn` and nothing else;
- the accept is sent once, fire-and-forget (`approveAccept` → `sendPlaintext` →
  `sendInviteControlPlaintext` → `relayClient.sendMessage`), and the relay's verdict on it is never
  recorded;
- the inviter's Finish prompt goes to its **Lifeline** topic, not the topic where the invite was made;
  with no Lifeline topic it returns silently, and a failed send lands in an empty `catch {}`;
- only the accepting side ever says "Paired with …"; an invite that expires unused tells nobody; nothing
  times out on the accepting side.

Justin's requirements (topic 61599, 2026-10-20, verbatim):

- *"I would expect BOTH sides to acknowledge success (or failure) to the user, meaning the agents
  themselves validate the completion, send some confirmation messages to each other through threadline,
  then confirm directly to the user that the connection is complete."*
- *"when I click 'Approve' I expect the agent that I clicked the button for should send a message saying
  they are now finalizing the connection and verifying they can chat with the other agent."*
- *"this whole process should be very responsive."*
- One code only; no second code (confirmed to him).
- When one person owns both agents, no second Finish tap (`docs/research/threadline/pairing-ux-proposal-2026-10-20.md`
  §5 Q1 in the-portal, answered for the same-owner case; see 11.6 for what can and cannot be proven).

### 11.2 New wire messages (additive, behind a capability flag)

Three control ops join the four of §4. All are `pair-invite-*` typed, so every existing path that treats
`pair-invite-*` as control (the inbound gate, the unknown-sender intercept, the plaintext-accept
exception in the client) handles them the same way and never routes them to a session.

| Op | Direction | Sent | Payload |
|---|---|---|---|
| `pair-invite-received` | A→B | encrypted to `idB` | `{ iid, exp, state, nonce, sig }`, `state` is `awaiting-operator` or `finishing` |
| `pair-invite-refused` | A→B | encrypted to `idB` | `{ iid, exp?, reason, nonce, sig }` |
| `pair-invite-hello` | both | encrypted to the peer's pinned key | `{ iid, exp, seen, nonce, sig }` |

Each `sig` is an Ed25519 signature by the sender's identity key over
`"threadline-invite-hs-v1" ‖ len-prefixed(op, iid, fpA, idA, fpB, idB, exp, field, nonce)`. A is always
the inviter and B the acceptor, whichever way the message goes. `exp` is the value carried in the
payload (empty in a refusal of an invite A does not know); a receiver that has its own record of the
invite also requires it to match. `field` is `state` (received), `reason` (refused), or the sender's
role and `seen` for a hello (`A:0`, `A:1`, `B:0`, `B:1`), so a hello cannot be reflected back as the
other side's. The receiver verifies against the key it pinned (B pinned `idA` at Approve; A pinned `idB` at Finish), so the relay
cannot forge, alter or re-label any of them. They prove nothing about the invite secret and carry none.

**Capability flag.** A new acceptor adds `hs: 1` to its accept; a new inviter adds `hs: 1` to its finish.
A side sends the new ops only to a peer whose message carried the flag. An older Instar or
`threadline-mcp` does not list the new ops as control messages, so it could pass one on as an ordinary
message from that agent; nothing new is ever sent to a peer that did not ask for it. The flag sits outside the
signature: a relay that strips it only turns the new behaviour off for that pairing (the messages in
11.7 then say the other agent runs an older version); a relay that adds it makes us send signed control
messages the other side drops. Neither can create, change or block a pairing.

### 11.3 The accept is retried until the inviter answers (threadline-core)

- B keeps the accept it built (it carries no secret: the tag and signature only) and resends the
  identical payload, each time in a fresh envelope, at **10 s, 30 s, 70 s, 150 s and 270 s** after the
  first send, until the inviter answers. A repeat accept from the same acceptor is already harmless on A
  (§4.4: `duplicate`, nothing changes), and five resends stay under A's limit of five accepts per minute
  per sender.
- **An answer** is any of, from that inviter, for that `iid`, verified against the pinned `idA`:
  `pair-invite-received`, `pair-invite-refused`, `pair-invite-finish`, `pair-invite-used`. Any answer
  stops the resends.
- A answers **every** accept it can attribute (one carrying `hs: 1`, with `fpB == first16(idB) == sender`)
  with `pair-invite-received` when the accept is valid (first or repeat), or `pair-invite-refused` when it
  is refused for a reason in 11.5. At most one answer per (sender, `iid`) per 5 s and ten per minute per
  sender.
- The relay's verdict on the first send of the accept (`delivered`, `queued`, `rejected` or none within
  15 s) is recorded and shown to B's operator (11.7 `accept-sent`).

### 11.4 Hello, then `paired` on both sides

Pairing is complete for a side only when **both** hold:

1. its own pin is `mutual-verified` (A: Finish recorded; B: the signed finish verified, §4.4.6), and
2. it has received a valid `pair-invite-hello` from the peer, decrypted and verified with the pinned key.

Then, and only then, it tells its operator `paired`. The hello travels the way ordinary chat to a paired
peer travels (encrypted to the pinned identity key's derived X25519 key, signed, through the relay), so
receiving it shows the two agents can talk privately, in that direction. Each side sends one, so both
directions are shown.

The exchange (`seen` = "I have your hello"):

- A sends `hello(seen=0)` right after Finish; B sends `hello(seen=0)` right after verifying the finish.
- On a valid hello, a side records it; if the peer's `seen` was 0, or this side has not yet sent
  `seen=1`, and its own pin is `mutual-verified`, it answers once with `hello(seen=1)`.
- A side resends its hello at **5 s, 20 s, 50 s, 110 s and 230 s** until it holds a peer hello with
  `seen=1`. Usually three messages settle it: A `0`, B `1`, A `1`.
- A hello that arrives before the side's own Finish/finish (it can overtake it) is kept and counts once
  the pin is `mutual-verified`.
- After a restart, a hello for a pairing this side had already completed (its pin is
  `mutual-verified`) is answered with `hello(seen=1)` and changes nothing else, so the other side still
  completes and a relay replaying an old hello cannot produce a fresh `paired` line. A finish that
  arrives after a restart is new, and runs the normal path (finish-received, hello, `paired`).
- **The inviter restarts between the accept and its Finish.** The accept's `hs` flag is lost with the
  restart, so the inviter does not know whether the acceptor speaks the handshake. It does not report
  anything yet: an acceptor that does speak it sends its hello once it has the finish (the finish always
  carries `hs: 1`), and the inviter answers that hello and both sides report `paired` (checked). If no
  hello arrives within **60 s**, the inviter reports `paired` unchecked, which is the truth for an older
  acceptor.
- Every handshake message for an invite carries that invite's own `exp`, taken from the invite itself
  on both sides (the acceptor reads it from the invite it approved, however the approve was driven).
- A side answers at most **6** hellos per pairing, at most one a second, so a replayed hello cannot
  drive sends without end.

**If the hello fails.** The pin is already `mutual-verified` (the cryptographic pairing of §4 is
complete), and it is **not** undone: undoing it on one side would leave the two sides disagreeing about
whether they are paired. Instead, **5 minutes** after the side's own Finish/finish with no valid peer
hello, it tells its operator `pairing-timeout` (stage `no-hello`): the pairing is recorded but the
agents have not shown they can talk. A hello that arrives later still produces `paired`. The credential
gate is unchanged (`mutual-verified` plus encryption to the pinned key, §4.5, standalone D7); whether it
should also wait for a hello is open question 11.10 Q2.

**Mixed versions.** If the peer did not send `hs: 1` (an older inviter's finish, or an older acceptor's
accept), there is no hello to wait for: the side tells its operator `paired` as soon as its own pin is
`mutual-verified`, with the "older version" wording in 11.7. An older inviter never sends a receipt,
so B's `no-answer` notice can fire while A's person is still deciding; B stops resending then, and a
finish that arrives later is still accepted and reported.

### 11.5 Refusals reach both operators

When A refuses an attributable accept (11.3), A sends B `pair-invite-refused` with one of these reasons,
and tells its own operator when the `iid` is one of its own invites:

| `reason` | When |
|---|---|
| `unknown-invite` | no such `iid` in A's store (revoked and purged, made on another machine, never made) |
| `expired` | the invite expired, or it is used and its K is gone |
| `revoked` | A's operator revoked it |
| `bound-elsewhere` | the invite is bound to a different agent |
| `key-mismatch` | `idB` differs from the key the relay presents for `fpB` |
| `not-them` | A's operator tapped **Not them** |
| `cannot-finish` | A could not record the pairing (a different key is already pinned for B) |

An accept that is malformed, has a bad tag or signature, names a fingerprint that is not its sender's,
or is rate-limited stays **silent** on the wire (§4.4.3, unchanged): answering it would turn A into an
oracle for anyone who can reach the relay. It is logged with its reason, and never only `console.warn`d
without a reason. A second VALID accept still gets `pair-invite-used` (§4.4.2), unchanged.

B verifies the refusal's signature against the pinned `idA`; an unverifiable refusal is dropped and
logged. On a verified refusal B stops resending and tells its operator. B's `invite-accepted` pin of A
is left as it is: it was never credential-eligible, and a later successful pairing replaces it.

**A refusal is not final.** A verified finish that arrives after a refusal wins: B tells its operator
`finish-received` and continues to the hello and `paired`. Two honest paths lead there (A's person
clears a stale key after `cannot-finish` and finishes; A refuses `key-mismatch` while a relay shows it
the wrong key, then accepts B's identical resent accept), and a refusal carries nothing that binds it
to one send of the accept, so a relay can also replay an old one. Letting the signed finish win means
the operator's last message is always the true outcome.

**What a refusal reveals.** The engine checks whether the invite is known and still open before it
checks the accept's tag, so an attributable accept naming a known `iid` with a wrong tag is told
`unknown-invite`, `expired` or `revoked`. That reveals only the state of an invite whose id the sender
already has; the relay sees every `iid` in the plaintext accepts anyway. On A, at most one refusal
notice is shown per invite, whoever sends, so accepts under fresh identities cannot flood the operator;
when the acceptor was not actually sent the refusal (it did not offer `hs`, or the rate limit held the
reply), the notice says it could not be told why. The cost, accepted: the first refused accept for an
invite uses up that notice, even one from a sender that only knows the `iid` of an expired or revoked
invite, so a later genuine refusal for the same invite is not shown to A's operator (the acceptor is
still told).

### 11.6 Same owner: finishing without a second tap

**What can be proven, stated plainly.** No signal available today lets agent A verify that the person
who tapped Approve on agent B is A's own owner. Each agent verifies only its own operator (§6.1); any
statement B makes about its operator is B's claim, and a Telegram user id is not a secret. So matching
operator ids is **never** used as authority (standalone spec D14 reached the same conclusion). The only
design that proves it is D14's deep link, where the secret reaches B only through B's own verified
operator; it needs the compact invite, which is not safe yet (standalone D14, last bullet).

**What this amendment does instead.** A's own verified owner may say, by an operator act on A, that a
given invite is for one of their own agents. That act **pre-authorizes the Finish** for that one `iid`:

- Where: a button **"It's one of my agents"** that A posts next to the invite in the topic where the
  invite was made (11.8), counted only under every §6.1 rule (lifeline-verified tap, enforce mode, the
  owner's user id, the agent's chat, a one-time token bound to this `iid`). The dashboard offers the
  same choice behind the PIN. The agent's Bearer token cannot set it.
- When: only while the invite is still `open`. A pre-authorization recorded after an accept arrived
  changes nothing (the Finish prompt is already out).
- Effect: when the **first VALID accept** for that `iid` arrives, A finishes by itself instead of asking,
  and tells its owner so (11.7 `auto-finished`), naming the claimed agent. Everything else in §4.4 is
  unchanged: a second VALID accept still alarms, demotes the first acceptor and sends `pair-invite-used`;
  an invite that already has a second accept is never auto-finished.
- Lifetime: in memory only. After a restart the pre-authorization is gone and the Finish prompt is used.
  Losing it can only add a tap, never remove a check.
- If the automatic finish fails (anything the engine refuses), the ordinary Finish prompt is shown
  instead, so the owner is never left with neither.
- Timing: "while the invite is still `open`" means until the first valid accept is recorded. A
  pre-authorization made while that accept is still being checked applies to it; the owner had seen no
  prompt yet, so that is the same as making it a moment earlier.

**Threat model, plainly.** The pre-authorizing tap is an operator act of the same strength as the Finish
tap, made earlier and without seeing the acceptor's claimed name. It does **not** prove that the person
who tapped Approve on B is A's owner. What it changes: with a pre-authorized invite, the only defence
against a leaked invite is the privacy rule (D2), single use, the expiry and the second-accept alarm,
because there is no later "Not them" moment. If an impostor uses a leaked pre-authorized invite before
the owner's agent does, the impostor is paired until the owner's agent uses the invite too (which
alarms and pauses the impostor) or the owner unpairs it after reading the `auto-finished` message, which
names the claimed agent. Without the tap, nothing changes: the Finish prompt stays.

This keeps one tap **after** the invite reaches B (Approve), and moves the inviter's decision to the
moment the owner is already looking at the invite. Justin accepted this as the same-owner flow until
D14's deep link exists (11.10 Q1, answered 2026-10-21).

### 11.7 Events and the words the operator sees

Every event becomes an operator message (11.8). Names are always the other agent's **claimed** names,
quoted. `<peer>` below is that name.

| Event | Side | Message |
|---|---|---|
| (Approve tapped) | B | Approved — finishing the connection with "<peer>" and checking we can talk… |
| `accept-sent` | B | delivered: Reached "<peer>". Waiting for it to answer… · queued: "<peer>" is offline right now. The relay is holding my approval, and I'll keep trying for 5 minutes. · rejected/none: I couldn't get my approval to "<peer>" yet (<relay reason>). I'll keep trying for 5 minutes. |
| `accept-received` | B | awaiting-operator: "<peer>" got my approval and is asking its person to finish. I'll tell you when it's done. · finishing: "<peer>" got my approval and is finishing now. |
| `accept-refused` | B | "<peer>" turned down my approval: <reason text>. Nothing was paired. |
| `accept-refused` | A | An agent that calls itself "<peer>" tried to use your invite, and I turned it down: <reason text>. I told it why. · not told (older acceptor): …: <reason text>. It runs an older version, so I couldn't tell it why. |
| (Finish tapped) | A | Finishing — checking we can talk with "<peer>"… |
| `auto-finished` | A | "<peer>" accepted your invite. You said it's one of your own agents, so I'm finishing by myself and checking we can talk… If that isn't your agent, unpair it on the dashboard's Threadline tab. |
| `finish-received` | B | "<peer>" finished its side. Checking we can talk… |
| `paired` | both | Connected ✓ "<peer>" and I are paired, and we've each checked we can message the other privately. · older peer: Paired with "<peer>" ✓. It runs an older version, so I couldn't check we can talk; it works as before. |
| `pairing-timeout` `no-answer` | B | "<peer>" hasn't answered my approval in 5 minutes, so nothing is paired yet. It may be offline. If it answers later I'll tell you; if not, ask its person to check it is running and send a new invite. |
| `pairing-timeout` `not-finished` | B | "<peer>"'s person hasn't finished, and the invite has now expired. If they finish later I'll tell you; if not, ask them for a new invite. |
| `pairing-timeout` `no-hello` | both | "<peer>" and I are paired, but it hasn't answered my test message in 5 minutes, so I can't confirm we can talk yet. I'll tell you if it answers. |
| `invite-expired` | A | Your pairing invite expired before anyone used it. Ask me for a new one if you still want to pair. |
| `invite-expired` | B | The invite from "<peer>" expired before you approved it. Ask them for a new one. |

Reason texts: `unknown-invite` "it doesn't know that invite (it may have been cancelled, or made on
another of its machines); ask for a new one"; `expired` "the invite had expired; ask for a new one";
`revoked` "its person cancelled that invite"; `bound-elsewhere` "that invite was made for a different
agent"; `key-mismatch` "the relay showed it a different key for me than the one I sent, so it refused,
as it should; tell the other person and don't retry"; `not-them` "its person said I'm not the agent they
meant"; `cannot-finish` "it already has a different key saved for me; its person needs to unpair me
first". On A the same texts describe the acceptor ("it", "them").

The wording lives in threadline-core (`pairingNoticeText`), host-neutral, so Instar and `threadline-mcp`
say the same thing.

**Timers.** B: `no-answer` 5 minutes after Approve with no answer (resends stop then). After
`received(awaiting-operator)`: `not-finished` at the invite's `exp` plus 10 minutes. After
`received(finishing)`: `no-answer` again 5 minutes after that receipt if no finish arrives. After the
finish: `no-hello` 5 minutes later. A: `no-hello` 5 minutes after its Finish (tapped or automatic).
`invite-expired`: A at `exp` for an invite still `open`; B at `exp` for an invite still waiting for its
operator's Approve. Timers are in memory: a restart cancels them (the restart notice of §8 covers B's
waiting invites). A timer for a far deadline re-arms until the deadline really passes. A timeout is a
notice, not an end: a later answer, finish or hello is still reported. `accept-sent` is shown only when
the relay's verdict is known (or did not come within 15 s); a transport that cannot report one shows
nothing rather than a false "couldn't get my approval".

### 11.8 Instar: where the messages go

- **The topic.** Each invite remembers the Telegram topic it belongs to:
  - A: the topic the agent posted the invite in. The server sees a `tlinv1:` token in an outbound
    Telegram reply, decodes it, and if it is one of this agent's own open invites, records
    `iid → topic`. `POST /threadline/pairing/invites` also takes an optional `topicId`. Nothing about the
    send changes.
  - B: the topic the invite was forwarded into.
  The record (`threadline/pairing-topics.json`, 0600, no secret, entries pruned 48 h after their invite
  expires) survives a restart. Events go to that topic, falling back to the Lifeline topic.
- **No topic at all** (no record and no Lifeline topic), or a send that fails: a `DegradationReporter`
  report (`Threadline.pairingNotices`) naming the event, instead of the old silent return and empty
  `catch {}`. The pairing state is never changed by a failed notice.
- **The Approve tap** answers the button and, at once, posts "Approved — finishing the connection with
  "<peer>" and checking we can talk…" in the topic. The Finish tap does the same with its own line.
- **Relay verdicts** on every invite control message sent (accept, received, refused, finish, ack,
  used, hello) are logged with the op, the peer's fingerprint prefix and the verdict, and fed to the
  engine for the accept.
- **Same-owner button** (11.6): posted in the invite's topic when A records `iid → topic` from an
  outbound reply, only when Telegram approval is on (§6.1); otherwise the dashboard offers it.

### 11.9 Where the code lives

The new engine (`handshake`) goes into `packages/threadline-core` with no imports at all (signing,
verification and transport are injected), so `threadline-mcp` and Instar run the same rules. Instar pins
core 0.1.0 from the registry and cannot import a module that version does not contain, so, exactly as
for the `encryptedSeen` mark (standalone §7 step 6), Instar carries a byte-identical copy below a header,
with a parity test that fails if the two drift. When a core release containing it is published and
Instar's pin moves to it, the copy and its parity test are deleted (standalone §7 step 3's rule).
`threadline-mcp` adopts it with that core release.

### 11.10 Questions for review

1. **Same owner (11.6).** Is a pre-authorizing tap on the inviter's side ("It's one of my agents") an
   acceptable same-owner flow until D14's deep link (which needs the compact invite to be made safe)
   exists? It removes the later Finish tap and its wait, but it is still a tap, and it is given without
   seeing the acceptor's claimed name. The alternative that matches "no second tap" literally is to
   finish without asking on a claim that both agents share an owner, which this amendment rejects
   because nothing can verify that claim.
   **Answered 2026-10-21 (Justin, topic 61599): yes.** The one-tap version ships.
2. **Credentials before the hello.** Should the credential gate also require that the peer's hello has
   arrived? This amendment leaves the gate as it is, because the hello tests exactly what the gate
   already requires (the pinned key and encryption to it) and a missing hello is usually a peer that is
   offline or older, not a wrong key.
3. **Announced across a restart.** A side that restarts between its own Finish/finish and the peer's
   hello answers the hello but does not announce `paired` (it cannot tell "announced before the
   restart" from "never announced", and announcing on any hello would let a relay replay an old one
   into a fresh "Connected ✓"); its `no-hello` timer is lost with the restart. Recording "announced" in
   the invite store would let it tell the two apart. Is that worth a store field?
4. **Timer values.** 5 minutes for the answer and the hello, and the resend schedules in 11.3 and 11.4,
   are chosen for "very responsive" on an online peer while giving an agent that is restarting time to
   come back. They are constants in core; review whether they should be longer for agents that sleep.
