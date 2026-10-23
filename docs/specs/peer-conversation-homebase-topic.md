---
title: A paired agent's conversation has no home — give each peer a topic
slug: peer-conversation-homebase-topic
date: 2026-10-22
author: echo
status: approved
approved: true
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
review-convergence: "2026-10-22T16:05:25.792Z"
review-iterations: 3
review-completed-at: "2026-10-22T16:05:25.792Z"
review-report: "docs/specs/reports/peer-conversation-homebase-topic-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
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

**One destination rule, for every peer message that is sent:**

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

### 2.3 Stop inheriting an unrelated topic

`ThreadResumeMap.ts:109`'s inheritance is removed for **peer** conversations. That is the actual
misdelivery mechanism; a peer conversation with no homebase and no deliberate binding is simply
parentless, which the approved routing design already handles.

### 2.4 A peer request that needs the operator posts there, notifying

The existing `SalienceGate` already decides `user-visible` vs `agent-internal`. A `user-visible`
peer message — `pp` asking the agent to contact the operator — is delivered **with
notification**, to the destination the 2.2 table selects. Salience decides whether it buzzes,
never where it lands: an operator-bound conversation's escalation still arrives in the topic the
operator chose. (An earlier draft sent every `user-visible` message to the homebase
unconditionally, contradicting 2.2.) Housekeeping is unchanged by this spec.

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
- Existing verified peers get a homebase on their next message in either direction, or on the
  sweep ~60s after server start (§6.1 — the backfill, built 2026-10-23).
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
  peer with no recorded homebase calls the same `ensurePeerHomebase`. A one-time sweep ~60s after
  server start covers peers that never write. Same discipline: recorded id first, then
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
