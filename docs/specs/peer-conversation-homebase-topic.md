---
title: A paired agent's conversation has no home — give each peer a topic
slug: peer-conversation-homebase-topic
date: 2026-10-22
author: echo
status: approved
approved: true
amendment-2026-10-31: "§2.6 user-meant routing. Approval basis: the operator's directive (Justin, 2026-10-31, relayed by the coordinating session): 'the whole point of the agent specific topic is that all messages from an agent that are intended for the user show up in that topic'. One internal review round on the amendment."
approved-by: "Justin (Telegram topic 127831, 2026-10-22 — scope cut approved \"Yes!\", with the build direction: \"Build the simplest version: when a pairing becomes mutual-verified, the lease holder creates ... a topic named after the peer and binds the peer conversation to it; peer requests that need Justin post there with a notification. Drop the crash-ordering intent-state machinery.\")"
approval-note: |
  Operator-DIRECTED, and deliberately below the skill's own convergence bar. He stopped the
  21-round draft for over-engineering and set the bar himself: fractal 80/20, one review round
  and at most three, stop when a round finds nothing that changes what gets built. Round 3
  returned MINOR ISSUES; its one build-changing finding was fixed and two precision findings
  were left, which is the bar he set rather than the one the skill defaults to.
eli16-overview: peer-conversation-homebase-topic.eli16.md
tracks: "topic 127831 · operator feature request 2026-10-21"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
review-convergence: "2026-10-31T21:40:23.000Z"
review-iterations: 5
review-completed-at: "2026-10-31T21:40:23.000Z"
review-report: "docs/specs/reports/peer-conversation-homebase-topic-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
amendment-2026-10-31b: "§2.7 per-message user-meant judging. Approval basis: the same operator directive as §2.6 (Justin, 2026-10-31: 'all messages from an agent that are intended for the user show up in that topic'), which §2.6 met only for the first message of a conversation; relayed by the coordinating session as the build order for this half. One internal review round on the amendment, iterated to concurrence (findings in upgrades/side-effects/peer-homebase-per-message.md)."
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Per-peer homebase topic

> **Scope note (operator direction, 2026-10-22).** An earlier draft of this spec ran 21 review
> rounds and reached 72KB, specifying crash-ordering state machines, duplicate-claim
> reconciliation, signed topic-ownership markers and adapter capability preconditions. The
> operator stopped it: *"Instar design and review has a habit of over-engineering, NOT applying
> the fractal 80/20 principle, NOT applying Occam's razor. 'Convergence' on reviews means it
> reaches fractal 80/20 convergence, it does NOT mean that all the long tail issues are
> resolved."* This version is the 80/20 feature. What the long version worried about is listed
> in §6 as deliberately left behind, with the risk named.

## 0. Constitutional traceability

**Parent principle: _The User Experience Is the Product — Reachability, Responsiveness, and
Coherence Are Sacred._**

The fit is the incident itself. A peer agent asked this agent to contact the operator; the agent
did post about it, and the operator still never saw it, because the notice landed in a
conversation about Claude quota. Nothing failed loudly — delivery succeeded, to the wrong place.
That is a coherence failure in the operator's own experience: the agent's knowledge and the
operator's view of it came apart, and the operator's only recourse was to notice the absence
himself and ask.

Two other standards govern pieces of this design rather than the whole:

- *Notices Route to the Alerts Topic, Never a New One* — this spec takes an explicit
  **`operator-ratified-exception`** to it (§2.5), recorded with the operator's own words, because
  he asked for exactly these topics.
- *Close the Loop* — the deliberately-cut long tail in §6 is carried by CMT-014 rather than left
  as a list nobody revisits.

## 0.1 Tracked deferral carrier (frozen excerpt) <!-- tracked: CMT-014 -->

Every `<!-- tracked: CMT-014 -->` marker in this document resolves to a real, durable commitment
with a follow-through beacon — not a comment and not a typed-in promise. Its immutable text is
inlined here so a reviewer can check the carrier actually covers the deferral without needing <!-- tracked: CMT-014 -->
API access. **CMT-013 was deliberately NOT reused**: that carrier covers the pool-read
destination-authentication work and would have been a mismatched carrier for these cuts.

> **CMT-014** — Registered follow-up for peer-conversation-homebase-topic section 6: the <!-- tracked: CMT-014 -->
> deliberately-cut long tail. (a) no crash-ordering intent state machine, so a crash between
> creating a topic and recording its id combined with a peer display-name change can duplicate
> a topic; (b) topic identity rests on its NAME plus a 6-char fingerprint suffix, with no signed
> ownership marker, so a same-named human-created topic would be adopted and a same-name
> same-prefix peer pair would collide; (c) no duplicate detection, winner or retirement records;
> (d) no eager replication of the homebase map and no recovery by enumerating Telegram, so a
> newly-promoted machine may not know a peer's homebase until replication arrives; (e) no
> backfill sweep for peers paired before this shipped, and no retry sweep for a peer whose
> creation failed and is never re-verified; (f) no per-conversation migration offers where one
> peer has several conversations. Also carries the unresolved conversation-CONTENT replication
> question in section 7, which is a third-party privacy decision belonging to the operator.

Opened against topic 127831 with `owner: agent`, `blockedOn: none` and a 7-day
`nextUpdateDueAt`, so the PromiseBeacon re-surfaces it until it is delivered or deliberately
withdrawn. That is what makes section 6 a tracked set of accepted risks rather than a list of
things nobody will look at again. <!-- tracked: CMT-014 -->

## 1. Problem

Peer agent `pp` asked this agent to contact the operator. The agent posted the notice into
whatever topic the `pp` conversation happened to be bound to — a Claude-quota conversation —
because `ThreadResumeMap.ts:109` does `draft.boundTopicId = entry.originTopicId`, so a peer
conversation permanently inherits the topic its thread started in. The operator saw nothing
relevant and asked for a dedicated, conventionally-named topic per peer agent: a homebase where
notices about that agent arrive, non-exclusive, so he always knows where to look.

## 2. Design

Four parts. Nothing else.

### 2.1 On mutual-verified, the lease holder creates the topic

`AgentTrustManager.markMutualVerified` is the trigger — it is the sole writer of the
mutual-verified source, so a stranger can never cause a topic. Downstream of that write (never
inside it; a failure here must not fail a pairing), the **serving-lease holder** creates a forum
topic named `"<peer> · Threadline · <fp6>"`.

**The name carries a fingerprint suffix**, so it is unique per peer:
`"<peer> · Threadline · <first 6 of fingerprint>"`. Two different peers choosing the same
display name would otherwise share one topic, since the map keys by fingerprint while
find-or-create keys by name. A six-character suffix costs nothing and removes the whole class.

**The fingerprint map is consulted FIRST, the name second.** `homebaseTopics[fingerprint]` is
the authority: if it holds a topic id, that is the homebase and nothing is created or looked up
by name. Only when the map has no entry does creation fall back to find-or-create on the name,
going through the existing funnelled primitive. This ordering matters for an ordinary case, not
a crash: a peer that **changes its display name** would otherwise get a second homebase, since
the name would no longer match.

Residual, accepted: the suffix **reduces** accidental collisions, it does not eliminate them —
two peers sharing both a display name and the first six characters of their fingerprint would
still collide on the name lookup. Accepted rather than engineered against (§6). (The map-first
ordering means this only matters for a peer with no map entry yet.)

Only the lease holder creates. A verification can be observed on any machine, so the observer
does not assume it is the holder:

- **Holder observes it** → creates directly.
- **Standby observes it** → sends one creation request to the holder (the same mesh call shape
  every other holder-only action uses) and records nothing itself.
- **The holder is unreachable** → nothing is created; the peer has no homebase and routing falls
  to rule 4. The next message with that peer, or the next server start, retries (§6.1).

Without this, a pairing verified on a standby would silently never get a topic — the normal
path, not a crash path.

### 2.2 The peer conversation binds to it

The homebase id is recorded as `homebaseTopics[peerFingerprint] = topicId`. Which conversation
binds, stated exactly, because "the peer's conversation" is ambiguous when there are zero or two:

| At creation time | Action |
|---|---|
| **No conversation exists yet** (pairing can precede any conversation — the normal case) | Record the map entry only. Nothing to bind. Later conversations resolve to the homebase by rule 3 of the destination table, with no retro-binding. |
| **Exactly one conversation** with that peer | Bind it, subject to the provenance table below |
| **More than one conversation** | Bind **none of them**. Rule 3 already routes any unbound one to the homebase, and choosing between bound ones is the operator's call (§6 — per-conversation migration offers are cut from this version) |

Binding is then subject to the provenance rule — **the operator's own binding always wins**:

`Conversation.boundTopicSource?: 'operator' | 'origin-inherited' | 'peer-homebase'` records
which. `hubCommands` writes `operator`, `ThreadResumeMap` writes `origin-inherited`, this
writes `peer-homebase`. Absent means a pre-existing record.

| Conversation state | Bind to the homebase? |
|---|---|
| `boundTopicSource: 'operator'` | **No** — never touched |
| A binding exists with provenance **absent/unknown** (every record predating this change) | **No** — it may be a deliberate operator binding made before the field existed. Overwriting it would destroy exactly the choice 2.2 promises to protect. |
| A binding exists with provenance `origin-inherited` | **Yes** — provably the accidental inheritance this spec removes |
| **No binding at all** | **Yes** |

So the rule is: bind when nothing was chosen, or when the record proves the binding was
accidental. Never when it *might* have been chosen. (`pp`'s own conversation is in the
unknown-provenance class, so it is re-homed by the operator's explicit request — which he has
already made — not automatically.)

**One destination rule, for every peer message that is sent** (superseded for messages meant
for the user by §2.6 — the operator's rule of 2026-10-31; this table now governs only the
agent-internal / housekeeping traffic, and the binding record itself):

| # | Condition (first match wins) | Destination |
|---|---|---|
| 1 | the conversation has an operator binding | the bound topic |
| 2 | the conversation has any other binding | the bound topic |
| 3 | no binding · the peer has a homebase | the homebase |
| 4 | no binding · no homebase | existing routing, unchanged |

A binding always decides the destination — the homebase is where an *unbound* conversation
goes. 2.4 adds notification, never relocation; an earlier draft let a `user-visible` message
reach the homebase even when the operator had bound that conversation elsewhere, which
contradicted "an operator binding always wins".

H3's completeness requirement applies: the conversation's **commitment `topicId`** is updated
alongside `ConversationStore`, because `captureOriginOnSend`'s first-write-wins would otherwise
keep the old destination and the bind would silently do nothing.

*Completeness note, as built (2026-10-31):* creation binds no conversation (`ensurePeerHomebase`
records the map entry only), so there is no bind whose commitment `topicId` could go stale. The
destination of a user-meant message is decided at delivery time (§2.6) from the live map and the
conversation's `boundTopicSource`, not from the commitment's `topicId`; the commitment keeps the
originating topic, which is still where the originating session lives.

### 2.3 Stop inheriting an unrelated topic

`ThreadResumeMap.ts:109`'s inheritance is removed for **peer** conversations. That is the actual
misdelivery mechanism; a peer conversation with no homebase and no deliberate binding is simply
parentless, which the approved routing design already handles.

### 2.4 A peer request that needs the operator posts there, notifying

The existing `SalienceGate` already decides `user-visible` vs `agent-internal`. A `user-visible`
peer message — `pp` asking the agent to contact the operator — is delivered **with
notification**, to the destination §2.6 selects (originally the 2.2 table; §2.6 supersedes it
for user-meant messages). An operator-bound conversation's escalation still arrives in the topic
the operator chose. Housekeeping is unchanged by this spec.

### 2.6 Operator rule: messages meant for the user land in the homebase (2026-10-31)

The operator, verbatim: *"the whole point of the agent specific topic is that all messages from
an agent that are intended for the user show up in that topic"*. Live evidence that §2.2's
"any binding wins" did not deliver this: on 2026-10-31 a peer (`scout`, the acceptor of an
invite pairing) received its first message from `echo` at 11:39, its `🤝 echo` topic was created
at 11:40, and the message was posted to an unrelated topic ("B2Lead Invoices"). Nothing read the
homebase at delivery time: `getHomebaseTopic` had no reader outside creation.

**Destination rule for a peer message meant for the user** (a `user-visible` SalienceGate
verdict, or a notice from that peer intended for the operator), first match wins:

| # | Condition | Destination |
|---|---|---|
| a | the conversation has `boundTopicSource: 'operator'` | that topic |
| b | the peer is mutual-verified and has a homebase | the homebase |
| c | otherwise | existing routing, unchanged |

Agent-internal and housekeeping traffic keeps the existing routing (the §2.2 table). This rule
decides where a message is POSTED and writes nothing: bindings, including unknown-provenance
ones, are still preserved as records (§2.2, §9).

**Delivery points it applies at:**

1. **A reply on a conversation this agent started from a topic** (`TopicLinkageHandler`, the
   `originTopicId` path, including the cross-machine ask): the reply is still handed to the
   originating topic's session (it is that session's work), and the user-facing `💬 Reply from`
   post goes to the §2.6 destination. When that destination differs from the originating topic,
   the server posts a `user-visible` reply there for every delivery mode, because the session's
   own inline relay would land in the originating topic. The session's payload tells it which
   topic the user reads this peer in. The originating topic gets no pointer (kept minimal: the
   session there already has the reply).
2. **An inbound message on a conversation with no topic link** (the relay inbound funnel, the
   local `/messages/relay-agent` route and the signed `/threadline/messages/receive` route): when
   the peer has a homebase, the server itself posts a `user-visible` message into it, with
   notification (`PeerHomebaseRelay`), instead of relying on whichever topic the receiving
   session picks. A message the relay does not post (agent-internal, rate-limited, send failed)
   falls back to the existing silent Threadline-hub surface, so none is left with no topic at
   all. A peer with no homebase keeps the hub.
3. **The session spawned for that conversation** is told the topic id to use if it writes to
   the user about it, so its own messages do not pick an unrelated topic.

**The peer is identified by fingerprint, never by display name.** A display name is whatever
the sender says it is; a name lookup would let an unpaired agent that calls itself "scout" post
into `🤝 scout`. The resolver accepts a profile only when the key equals that profile's own
fingerprint: the relay-authenticated sender fingerprint, the signature-derived fingerprint on the
signed HTTP route, and on the local route the signature-proven fingerprint or, failing that, the
one the local registry holds for the name (the identity that route already trusts).

**Both pairing sides create the homebase at mutual-verified.** The invite flow previously created
none at pairing time: only the 12-word confirm route did, and the invite sides waited for the
first message's contact hook, which ran concurrently with that message's delivery. The invite
handshake's own notices now trigger creation: `finishing` on the inviter (its person tapped
Finish), `finish-received` on the acceptor (the inviter's signed finish arrived), with `paired`
as a backstop. Creation keeps its existing discipline (lease holder only, create-once,
best-effort, never fails a pairing).

**Brakes.** `PeerHomebaseRelay` posts at most once per thread per minute and three times per
topic per minute, the same bounds the topic-linked surface uses; a post held by a brake falls
back to the hub surface (above).

**What is structural and what is not, stated plainly.** As first built, whether a message is
meant for the user was the existing SalienceGate's verdict, which production runs without a
classifier; its fallback marks only the FIRST message on a thread as `user-visible`, so a later
user-meant message relied on the session following a prompt line. §2.7 closes that: every
message is judged, and the first-only rule remains only as the behaviour of the off switch.

**Off switch.** `threadline.peerHomebase.enabled: false` (read live) makes the resolver return
the existing routing everywhere, which restores the previous behaviour exactly.

**Signal vs authority.** This is delivery routing, not a gate: it never blocks, delays or drops a
message, and every failure falls back to the existing destination.

### 2.7 Every message is judged "meant for the user?" (2026-10-31, second half)

§2.6 delivered the operator's rule for the first message of each conversation only. This makes
the server post EVERY peer message meant for the user into the §2.6 destination, by deciding
"meant for the user?" per message (`PeerUserMeantJudge`, `src/threadline/PeerUserMeantJudge.ts`).

**The decision, in order** (first that answers wins):

| # | Step | Result |
|---|---|---|
| 1 | Protocol traffic, by wire type: `ack` or `wellness`, or the exact fixed ack sentences (`DEFAULT_AUTO_ACK_MESSAGE`, `NO_REPLY_ACK_MESSAGE`) older peers send without a type | agent-internal, no model call |
| 2 | The text could not be secret-scrubbed, or no model is available at all | no verdict → post |
| 2b | The judge's own budget is spent: the daily cap (default 300 model calls, seeded from the audit log so a restart does not reset it) or the per-peer limit (default 30 judged messages per rolling hour; a peer is charged only when a model is actually asked) | the §2.6 first-only rule, with its brakes, decides. A budget is a brake: exhausting it must not become "post everything unjudged" |
| 3 | Jev (TypeSafe, vault `typesafe_api_key`): a calibrated three-way choice (meant for the person / agent coordination / cannot tell). A confident answer outside the shared cascade band (0.30–0.70) decides | Jev's answer |
| 4 | Jev unsure, "cannot tell", absent or failing → the referee chain, in order: the Codex fast tier (its own breaker), then the agent's shared provider. The first parseable answer decides | the referee's answer |
| 5 | Nothing answered, or the decision's deadline passed | no verdict → post |

So the judge works fully on a single provider: a Claude-only agent with no Jev key asks the
shared provider. It fails toward POSTING: a duplicate notice is better than a missed one. Only
deterministic protocol types are never posted, and only a spent budget falls back to first-only.

**Judged by meaning, never by string match.** The question (to Jev and to the referees) asks
whether the message is meant for the receiving agent's person to read: it addresses or asks the
person, asks the receiving agent to tell or pass something on to them ("tell Justin", "for your
person", "please pass this on"), needs their decision, approval, answer or action, or carries a
result, report, warning or news they would want. Coordination the receiving agent can handle
alone is agent-internal. The message reaches a model only after the durable secret scrub, quoted
as data the model is told not to follow (fenced); the peer-asserted sender name is reduced to one
line without control characters so it cannot fake that layout; a private-key marker sends
nothing (and posts). **Egress:** the scrubbed message text leaves the machine to TypeSafe (Jev)
when a key is configured, and to the Codex or shared provider's vendor when they answer.

**Where it applies.** (a) `PeerHomebaseRelay`, all three inbound seams of §2.6 point 2; each seam
passes the wire type it has. (b) `TopicLinkageHandler`, only when the reply is REDIRECTED to the
homebase (§2.6 point 1). The verdict feeds the session payload, so the inject of such a reply
waits for it, at most 6 s (Jev answers in about 1.5 s; a referee can take longer), then posts on
no verdict. Elsewhere the SalienceGate decides exactly as before, with no added wait.

**Brakes under per-message judging.** The per-thread one-post-a-minute brake of §2.6 is lifted
for judged messages (a second user-meant message inside a minute is still meant for the user);
the per-topic brake (three posts a minute into one topic) stays as the flood bound. A judged
user-meant post held by that brake, or whose send failed, is retried (at most twice, at most 50
pending, after the window frees or 30 s), and the hub surface runs meanwhile, so the homebase
still gets it. The judge's own budget (step 2b) bounds model spend.

**No double posting.** The spawn-prompt line of §2.6 point 3 now says, only where the relay has
actually taken the thread, that the server posts each message from that peer it judges meant for
the user into topic N, so the session must not repost, forward or summarise them, and posts in its
own words only what it adds (including a point it thinks the user still needs). "Taken" means:
the relay resolved the homebase for this thread from the transport's own sender evidence and
judged a message of it with the switch on (recorded synchronously at ingest, before the spawn),
the switch is still on, and the conversation is unbound. Otherwise the §2.6 line stands. The topic-linked payload already said the server
posted a user-visible reply.

**Audit.** One content-free row per judged message in `logs/peer-user-meant.jsonl`: time, the
first 8 characters of the thread id, the first 12 of the peer fingerprint, the message length,
the verdict, who decided (`protocol` / `jev` / `referee` / `no-verdict`), a closed-enum reason,
Jev's probability, which referee answered, and the model calls made. No message text. Model
calls are also metered under the `peer-user-meant` feature on `/metrics/features`.

**Switch.** `threadline.peerHomebase.perMessageClassification`, read live per message. Omitted or
`true` ⇒ on (the operator's directive). Explicit `false` ⇒ the §2.6 first-only behaviour exactly.
An object form carries tuning: `{ "enabled": true, "maxChecksPerDay": 300, "perPeerPerHour": 30 }`.
`threadline.peerHomebase.enabled: false` still turns the whole homebase routing off.

**Signal vs authority.** The verdict decides only whether the server posts a COPY to the operator's
topic. It never blocks, delays or drops the message on its way to a session; every failure
resolves to posting. It holds no authority over the peer or the session.

**Limits, stated plainly.**
- Past the daily cap or a peer's hourly limit, only the first message of a conversation is posted
  by the server (§2.6) until the budget resets; a later user-meant message then depends on the
  session again. One busy peer can spend the shared daily cap for every peer.
- A judged post that still fails after its retries stays in the silent hub only.
- A wrong agent-internal verdict means no server post; the session was told not to repost the
  peer's messages, so its own words are the only remaining path (the prompt invites it to add a
  point it thinks the user still needs).
- The spawn prompt is fixed when the session starts: switching per-message judging off later
  leaves a running session believing the server posts; it learns otherwise only on respawn.
- The session can still post its OWN messages about a peer elsewhere; the prompt line is the only
  control there (unchanged from §2.6).
- A bound, non-operator conversation with no thread-resume entry is handled by neither the relay
  nor the topic-linked path (pre-existing, unchanged; §2.6 under-block).
- Model verdicts can be wrong in both directions; the measured rate is not known yet. The audit
  log is the input for measuring it.

**Review round (internal, one).** Findings and their resolution are recorded in the side-effects
artifact `upgrades/side-effects/peer-homebase-per-message.md`.

### 2.5 Why automatic creation is permitted here

*Notices Route to the Alerts Topic, Never a New One* exists because an agent minting
notification topics flooded this operator before, and it is why the 21-round draft made the
homebase an offered tap rather than an automatic creation. The operator reversed that
deliberately:

> *"I think we should have an INSTAR standard here such that there is one dedicated topic
> that's created for each agent that an agent is communicating with"* — and, on the
> over-engineering of the offered-tap design, *"Convergence on reviews means it reaches fractal
> 80/20 convergence, it does NOT mean that all the long tail issues are resolved."*

So this is an **`operator-ratified-exception`**, not an oversight, and it is bounded by
construction rather than by a ceiling: one topic per *mutually-verified peer*. Pairing is
human-gated — mutual-verified is reached through the operator-tapped pairing flow, and
`markMutualVerified` is its sole writer — so the agent cannot grow the set on its own. (The
enforcement lives in the pairing flow, not in this spec; stated as the precondition this design
relies on rather than re-derived here.) The universal last-resort ceiling inside the creation primitive still
applies, as it does to every caller.

This spec adds **no new blocking authority** — it creates and binds; it gates nothing
(signal-vs-authority).

## 3. Decision points touched

| Decision point | Class | Note |
|---|---|---|
| Does this conversation bind to the homebase? | `invariant` | A two-row deterministic rule on `boundTopicSource` (2.2). No competing signals: the operator's own binding is the only thing that can beat the homebase, and it always does. |
| Does a peer message notify? | `invariant` | Delegated unchanged to the existing `SalienceGate`; this spec adds no classifier. |


## 4. Tests

- **Unit** — the bind rule in all four cases, each asserted separately: `operator` untouched;
  **an existing binding with absent provenance untouched** (the legacy-operator-binding case);
  `origin-inherited` bound; no binding bound;
  the name carries the peer's fingerprint suffix; two peers with the same display name get different topics; find-or-create returns the existing topic for a repeat;
  the commitment `topicId` is written alongside the conversation.
- **Integration** — `markMutualVerified` on a fresh peer produces a topic and a binding; a
  standby produces neither; a `user-visible` peer message notifies and is delivered to the
  **2.2-selected** destination — including the case where the operator bound that conversation
  somewhere other than the homebase, which must still arrive in the operator's topic. Asserted
  on the **delivered destination**, not on field values.
- **E2E** — a real pairing on a test agent: topic created, conversation bound, an escalation
  arrives in the right topic.

## 5. Migration parity

- New state: `homebaseTopics` map (additive).
- `Conversation.boundTopicSource` additive + optional; absent must load unchanged.
- CLAUDE.md: `generateClaudeMd()` **and** a content-sniffed `migrateClaudeMd()` section — an
  agent that does not know the topic exists will not use it.
- Existing verified peers get a homebase from the bounded pass ~90s after server start
  (`backfillPeerHomebases`), or on their next message in either direction (§6.1, built 2026-10-23).
- Config key `threadline.peerHomebase.enabled`, default ON (§6.1); `false` turns it off.

## 6. Deliberately left behind (the long tail, with its risk named)

The operator's direction was to accept long-tail risk rather than engineer it away. What was cut
from the 21-round draft, and what it costs:

| Cut | Risk accepted |
|---|---|
| Crash-ordering intent state machine (`intent-recorded` → `create-attempted` → `committed`) | A crash between creating the topic and recording its id leaves the map empty, so the retry falls back to the **name** lookup — which searches the forum's existing topics and therefore normally **recovers** the orphan rather than duplicating it. A duplicate needs the rarer combination of that crash AND the peer's display name having changed in between. Judged rare and cheap to fix by hand. |
| Signed topic-ownership markers + provenance-verified adoption | Topic identity rests on its **name**. A human-created topic with the same name would be adopted. Judged acceptable: the operator is the only other author in their own forum. |
| Duplicate-claim detection, durable winner/retirement records | If a duplicate does occur, nobody is told; the operator notices two similarly-named topics. |
| Eager replication of the map + recovery by enumerating Telegram | A newly-promoted machine may not know a peer's homebase until the record replicates; peer notices fall back to existing routing in the meantime. |
| Adapter capability preconditions + tests | Taken on trust that the existing create/post primitives work, which they demonstrably do elsewhere. |
| Bounded/paginated rendering of a control post | No control post in this version — creation is automatic, so there is nothing to render. |
| Per-conversation migration offers for multiple conversations with one peer | Only the peer's conversation binds (2.2); a second conversation with the same peer keeps its binding. |

Each is recorded as a tracked item rather than forgotten. <!-- tracked: CMT-014 -->

### 6.1 Backfill and default-on (built 2026-10-23, after the cut above proved wrong)

The cut "they get a homebase on their next verify" left `pp` — paired 2026-10-21, a day before
this merged — with no homebase forever, because a verified pair is never re-verified. And the
dev-agent gate kept creation off on every fleet build, including the operator's own Mama PC.

- **Backfill.** `PeerHomebaseBackfill` hangs off the canonical thread-log funnel
  (`attachPeerContactHook` around `ThreadMessageRecorder.record`): a NEW leg, inbound or outbound, for a mutual-verified
  peer with no recorded homebase calls the same `ensurePeerHomebase`. Peers that never write are
  covered by the bounded boot pass `backfillPeerHomebases` (~90s after start, which also renames
  legacy-named topics); the contact path forwards the same naming/adoption helpers. Same discipline: recorded id first, then
  find-or-create by name; lease holder only (read live, so a lease move is handled); a stranger
  (not mutual-verified) can never cause a topic; concurrent contacts share one creation; a failed
  creation waits 10 minutes before that peer is tried again.
- **Gate default ON.** `threadline.peerHomebase.enabled` now defaults on; explicit `false` is the
  off switch. The operator asked for one topic per paired agent by name (§2.5), pairing is
  human-gated, and the blast radius is one topic per peer, so the 7-day dev soak below bought
  nothing worth the silence. This supersedes the maturation plan's dark-on-fleet stage.

## 7. Multi-machine posture

| Surface | Posture | Note |
|---|---|---|
| `homebaseTopics[fingerprint]` | **unified** | Replicated with the peer record, the way system-topic ids already are. |
| `boundTopicSource` | **unified** | A field on the conversation record, replicated under its existing class. |
| Where a user-meant message is posted (§2.6) | **machine-local by design** | Decided on the machine that receives the message (the relay holder, or the topic owner for a cross-machine reply ask), from the replicated trust profile and conversation record; the post goes through that machine's Telegram adapter like every other post. |
| Which machine creates | **machine-local** · `machine-local-justification: physical-credential-locality` | The Telegram bot token and the forum namespace its topic ids live in are bound to one credential on one disk; an id minted under another machine's token is meaningless. |

Conversation **content** replication is unresolved in the surrounding subsystem (a third-party
privacy decision that is the operator's, not an agent's) and is out of scope here; this spec
decides where notices land. <!-- tracked: CMT-014 -->

## 8. Self-heal posture

No monitor and no recurring notice source: a create-once action on a human-gated event. If
creation or the forward-to-holder fails, the pairing still succeeds, nothing is bound, the
failure is **logged with its reason**, and the next `markMutualVerified` for that peer retries.
No escalation path, so the Self-Heal-Before-Notify gate does not apply.

**The loop this leaves open, named rather than implied:** a peer whose creation failed and who
is never re-verified keeps no homebase and nobody is told. There is no retry sweep in this
version — that is the §6 cut, and it is carried by the tracked item there rather than left to
anyone's memory. Routing degrades to existing behaviour in the meantime, so the cost is a
missing convenience, not a lost message.

## 9. Verify the State, Not Its Symbol

| Symbol | Claimed state | Corroboration | If unmeasurable |
|---|---|---|---|
| A topic exists with the peer's name | "this peer has a homebase" | None beyond the name — **accepted as a named long-tail risk** (§6), on the operator's direction | Creation fails, nothing is bound, retried on next verify |
| `boundTopicSource` | who chose this binding | The three writers are the only writers | **An existing binding with absent provenance is PRESERVED, never bound** (2.2) — it may be a deliberate operator choice from before the field existed. Only "no binding at all" or a proven `origin-inherited` binding is bindable. |

## Maturation plan

This feature creates a Telegram topic and re-points a conversation, so it gets a real rollout
rather than shipping on or shipping dark forever.

- **dark-window:** none. The feature is gated by `threadline.peerHomebase.enabled`, which
  defaults **on everywhere** since 2026-10-23 (§6.1); it first shipped live on a development
  agent and off on the fleet.
  There is no dry-run stage: the action is "create one topic and bind one conversation", which
  cannot be usefully rehearsed without doing it, and its blast radius is one topic.
- **test-agent-live:** a throwaway agent pairs with a throwaway peer; assert the topic appears,
  the conversation binds, an escalation arrives there and notifies, and a second pairing of the
  same peer creates nothing new. This is the Live-User-Channel Proof for the feature — driven
  through real Telegram, not a mock.
- **dev-agent-live:** enabled on this agent (echo) immediately on merge, with `pp` as the first
  real case: `pp`'s conversation is re-homed by the operator's standing request and the result
  verified in his actual Telegram.
- **fleet:** flipped on by default 2026-10-23 (§6.1) rather than after 7 days — the operator
  asked for the behaviour by name.
- **graduation criterion:** across the dev-agent window — every mutually-verified peer has
  exactly one homebase topic; **zero** operator-bound conversations were re-pointed (the
  invariant this design exists to protect); and no duplicate topic required manual cleanup. A
  single violation of the first or second holds the flip and is investigated rather than
  waived.

## Frontloaded Decisions

- **Topic name:** `"<peer> · Threadline · <fp6>"` — the parent spec's name plus a short fingerprint suffix for per-peer uniqueness.
- **Automatic creation, not an offered one.** The earlier draft made it an operator tap to
  satisfy a destination-policy standard. The operator's direction reverses that: he asked for
  the topic, and one topic per paired agent is a bounded set he wants.
- **Binding precedence:** an operator binding always wins.
- **Escalations notify;** housekeeping is untouched by this spec.

## Open questions

*(none)*
