---
title: "Threadline Conversation Coherence — which machine holds each agent-to-agent conversation (P3 of multi-machine coherence)"
slug: "threadline-conversation-coherence"
author: "echo"
eli16-overview: "THREADLINE-CONVERSATION-COHERENCE-SPEC.eli16.md"
status: "converged-approved"
approved: true
approved-by: "justin (standing directive)"
approved-evidence: "Topic 13481, 2026-06-06 ~03:05 PDT: 'Yes, please enter a 24 hour autonomy session and continue to proceed through each project step making sure you implement each one and tested extremely thoroughly'. ELI16 sent to topic 13481 at approval."
layer: "core-instar-primitive"
parent-principle: "Structure beats Willpower — every machine knows which machine holds each A2A conversation by machinery, not by remembering where the relay was connected"
parent-spec: "MULTI-MACHINE-COHERENCE-MASTER-SPEC.md"
project: "multimachine-coherence"
project-items: "P3.1 threadline-conversation-journal-kind, P3.2 machine-swap-semantics"
supervision: "tier0 — deterministic journal-kind emission + read-side merge; no policy decisions. Justified per LLM-Supervised Execution."
lessons-engaged: >
  P19 (emissions ride the store's commit() funnel + journal rate caps; the
  mesh read is bounded: own rows from the live store, replica fold under
  the P1 reader's byte/archive ceilings with partial-result honesty);
  Signal vs Authority (the view never actuates — relay binding and reply
  routing stay with the live holder); Close the Loop + Deferral = <!-- tracked: multimachine-coherence-p3-threadline-registry-machine-swap -->
  Deletion (the P1.5 beacon-transfer deferral stays OPEN and tracked in <!-- tracked: multimachine-coherence-p3-threadline-registry-machine-swap -->
  COMMITMENTS-COHERENCE-SPEC §2; P3 contributes the uniform
  visibility-vs-actuation decision and names P1.5's merged view as the
  beacon-holder observable — it does NOT claim closure); Migration Parity
  (compiler-guided multi-site kind addition; retention via ConfigDefaults
  add-missing; Agent Awareness on all THREE surfaces incl. shadow
  markers).
inherited-invariants: >
  This spec INHERITS the converged P1 invariants (COHERENCE-JOURNAL-SPEC),
  the P2 additions (WORKING-SET-HANDOFF-SPEC), and the P1.5 additions
  (COMMITMENTS-COHERENCE-SPEC) by reference: typed per-kind schemas (free
  text structurally excluded); first-hop-only trust; bounded everything;
  replicated data is SIGNAL never actuation authority; single-writer
  streams; incarnation fencing. Reviewers: treat violations as material
  without re-deriving them.
review-convergence: "2026-06-06T12:29:26.958Z"
review-iterations: 2
review-completed-at: "2026-06-06T12:29:26.958Z"
review-report: "docs/specs/reports/threadline-conversation-coherence-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
---

# Threadline Conversation Coherence (P3)

> **One sentence:** every machine can answer "which machine holds the
> conversation with <peer agent>, and is it bound to a topic?" from local
> disk — a 4th coherence-journal kind emitted at the ConversationStore's
> lifecycle chokepoints and replicated by the transport P1 already built —
> so an A2A thread stops being invisible from the machine the user happens
> to be on.

## 1. Motivation (master spec §"the journal's kinds", P3 row)

Threadline conversations (agent-to-agent threads with Dawn, Codey, …) live
in a machine-local ConversationStore, and the relay connection that
receives a peer's messages is bound to ONE machine's fingerprint. On a
two-machine agent: the Mini cannot answer "what did Dawn and I agree
yesterday?" — worse, it doesn't know the conversation EXISTS, or that its
replies must originate from the Laptop's relay. The master spec names
`threadline-conversation` as a journal kind for exactly this ("which
machine holds it — P3's foundation").

**Deliberately narrow:** P3 makes conversation EXISTENCE + HOLDER + topic
binding coherent. Conversation CONTENT does not replicate (it stays in the
holder's store, synced per its registry class; the P1 id+status posture —
A2A content can carry peer-confidential material that the same-operator
disclosure note does not automatically cover, because the COUNTERPARTY is
not the operator).

## 2. Scope

**In:**
- P3.1 — the `threadline-conversation` journal KIND: emitted at the
  ConversationStore lifecycle chokepoints, replicated for free by the
  EXISTING journal-sync transport (kinds are generic), readable through
  the EXISTING `GET /coherence/journal` (kind filter) plus one NEW
  convenience route `GET /threadline/conversations` (round-1 correction:
  no such route exists today — nearest are /threadline/observability/*;
  this is a new route + a new fold function, not a query-param addition)
  that merges own + replica conversation records with holder + staleness
  tags.
- P3.2 — machine-swap semantics: what happens to a topic-bound
  conversation when its TOPIC moves machines (it does NOT auto-transfer —
  the relay identity is machine-bound; the receiving machine instead
  KNOWS the holder and says so), plus the commitment-actuation note that
  absorbs P1.5's beacon-transfer deferral. <!-- tracked: multimachine-coherence-p3-threadline-registry-machine-swap -->

**Out (explicitly):**
- Conversation content replication (stated above).
- Relay identity transfer between machines (the routing fingerprint is a
  machine-level credential; moving it is a re-keying operation, not a
  sync). **Lineage freeze:** P3's action vocabulary deliberately has no
  transfer/re-home action. If deliberate re-homing is ever built, it MUST
  emit a new action (or a lineage field linking old and new
  conversationIds) — a close-on-A + start-on-B pair is NOT semantically
  equivalent and consumers must never be taught to infer it.
- Cross-agent anything (this is one agent's machines).

## 3. Design

### 3.1 The journal kind (P3.1)

`JOURNAL_KINDS` gains `'threadline-conversation'`. HONEST SIZING (round
1): this is a COMPILER-GUIDED MULTI-SITE edit, not a one-liner — the
`JournalKind` union change forces a compile error at every
`Record<JournalKind, …>` literal (nextSeq, highWaterSeq, opKeys,
retention merge, rateBuckets, persistMeta — 11+ sites), plus a new
`validate()` schema branch, a new `opKeyOf()` branch, a new
`emitThreadlineConversation()` emitter, AND the receive-side
`JournalSyncApplier.validateData()` branch — WITHOUT which the applier
rejects the unknown kind and suspect-flags the sending peer (replication
would silently fail; §5's transport-inheritance is wholesale for
transport, NOT for the schema validators). The type system makes every
site mechanically discoverable; none may be skipped. Retention:
`{ maxFileBytes: 8 MiB, rotateKeep: 8 }`. Old readers (previous
versions) skip unknown-kind stream files by construction (their
JOURNAL_KINDS filename loop never matches) — mixed-version degrades to
local-only visibility.

Typed schema (free text structurally excluded, the P1 invariant):

```
interface ThreadlineConversationData {
  action: 'started' | 'bound' | 'unbound' | 'closed';
  conversationId: string;       // the store's id — opaque, content-free
  peerFingerprint: string;      // the counterparty's routing fingerprint
  topicId?: number;             // present on bound/unbound
}
```

Emission chokepoint — REALITY-CORRECTED (round 1): ConversationStore has
no named create/bind/close methods; its single-writer funnels are
`mutate(threadId, fn)` / `mutateSync` and every write commits through
`commit()` (~line 403). The emission therefore lives INSIDE `commit()` as
a TRANSITION DIFF — comparing prev vs next `state` and `boundTopicId` to
derive `action` ('started' on first commit, 'bound'/'unbound' on
boundTopicId change, 'closed' on a terminal state) — exactly the
diff-derived pattern StateManager.saveSession uses for session-lifecycle.
The diff is on `state` + `boundTopicId` ONLY — a
non-lifecycle commit (message append, lastActivity bump, unread-count
write) changes neither field and emits NOTHING (the kind records
lifecycle, never traffic). This requires a NEW seam interface (`emitThreadlineConversation`) + a
`ConversationStore.setCoherenceJournalSeam(...)` setter + one wiring line
where the store is constructed (server.ts ~8056, where the journal is in
scope) — the PATTERN is the telegram seam's, the TYPE is new. Schema
mapping confirmed against the real store: `conversationId` = `threadId`,
`peerFingerprint` = `participants.peers[]` entries (fingerprints, not
display handles), `topicId` = `boundTopicId`. Op-key idempotency:
`(conversationId, action, topicId?)` — NOTE this needs its own `opKeyOf`
branch (the existing branches key on `entry.topic`; conversationId lives
in `data`). Emissions inherit the writer's rate caps; no new loops (P19).

The peer fingerprint is identity METADATA, not content — it already
travels peer-visible in every A2A envelope. The conversation TITLE,
message text, and peer display names never enter the journal.

### 3.2 The merged read (P3.1)

- `GET /coherence/journal?kind=threadline-conversation&...` works with
  ZERO new code (the reader is kind-generic).
- NEW convenience route `GET /threadline/conversations?scope=mesh`.
  **Bounded by construction (round 1 — a mesh-wide fold needs P1's read
  discipline, not an assertion):** OWN rows come from the LIVE
  ConversationStore (the authority — no fold, no journal read at all for
  own truth); ONLY replica rows fold from peer journal streams, under
  the P1 reader's existing bounds (per-query byte ceiling, capped
  archive scan, newest-first) with the partial-result flag set when a
  bound is hit — an old-but-active replica conversation whose `started`
  entry scrolled past the bound surfaces as partial-result honesty,
  never a silent omission. The kind's rotation (8 MiB × keep 8) makes a
  bound-hit a misbehavior signal, not a working state. OWN-stream journal entries are
  IGNORED by this route entirely (the live store is authoritative for
  own conversations; folding our own journal would only add a second,
  staler copy of the same rows). The fold produces
  current-state rows
  `{ conversationId, peerFingerprint, holderMachineId, boundTopicId?,
  status, source, stalenessMs }`. **Fold rows are keyed by the COMPOSITE
  `(holderMachineId, conversationId)`** — conversationIds are unique only
  within one store (the P1.5 identity lesson, applied at design time this
  round); the fold is PER-STREAM last-writer on `seq` (each machine's own
  stream is the only writer for its conversations — single-writer by
  construction; cross-stream causal ordering is never needed because no
  two streams describe the same row). A replica stream currently marked
  `gapped`/`suspect` (P1 §3.4 states) renders its rows with an explicit
  `streamStatus` qualifier — a fold over a known-incomplete stream says
  so rather than presenting a possibly-rolled-back binding as current.
- **Signal vs Authority:** the merged view answers "where is it?"; it
  never routes a message, never re-binds a relay, never closes a
  conversation. The holder's live store remains the only actuation
  authority.

### 3.3 Machine-swap semantics (P3.2)

When topic N (bound to conversation C held on machine A) transfers to
machine B:

1. **The conversation does NOT move.** C's relay binding is A's routing
   fingerprint; peers deliver to A. Auto-transferring would be a silent
   re-keying with peer-visible identity consequences — explicitly out.
2. **B KNOWS, and says so honestly.** B's replica of A's journal shows C
   bound to N and held by A. When the user (now on B) references the
   Dawn thread, B answers from the merged view: "that conversation lives
   on <A>; it's still receiving there" — never "no such conversation."
   The STRUCTURAL surface is the route itself — `GET /threadline/
   conversations?scope=mesh` answers with the holder regardless of any
   prompt (Structure beats Willpower); the CLAUDE.md trigger (user
   references an A2A thread not held here → consult the route and name
   the holder; never claim the thread doesn't exist) is the awareness
   layer ON TOP of that structure, not the enforcement.
3. **Topic-binding stays coherent:** the binding (topic N ↔ conversation
   C) is journal data; B's topic-side features (the Threadline hub
   surfacing, reply-binding displays) read the merged view, so the
   binding survives the move even though the conversation didn't.
4. **If A is offline** — REALITY-CORRECTED (round 1, grounded in
   RelayServer.ts:1058-1075 + OfflineQueue.ts): inbound to an offline
   holder is held by the CENTRAL RELAY's offline queue — by default
   IN-MEMORY, 24h TTL, bounded, dropped on expiry or relay restart, with
   a `delivery_expired` frame back to the sender. There is NO peer-side
   redelivery loop (the sender gets a `queued` ack and is done). The
   honest answer template therefore carries BOTH the staleness of our
   replica and the real delivery bound: "as of <recvTs>, the <peer>
   conversation was held on <A>, bound to this topic; <A> is currently
   unreachable, so this may be out of date — peers' messages queue at
   the relay for up to ~24h and resume if <A> returns within that
   window; beyond it they may be dropped." Present-tense certainty off a
   stale replica is forbidden (the inherited §4.2 honesty rule applied
   to the WORDING, not just the data). A stronger resume promise
   requires the durable RedisOfflineQueue as a named precondition — not
   assumed.
5. **Commitment-actuation note (the P1.5 beacon deferral, anchored):** <!-- tracked: multimachine-coherence-p3-threadline-registry-machine-swap -->
   COMMITMENTS-COHERENCE-SPEC §2 Out (converged 2026-06-06, branch
   echo/coherence-p15-commitments — reviewers on other branches will not
   see the file; cite, don't grep) defers beacon-duty TRANSFER and
   tracks it against this P3 round item. What P3 contributes is the
   uniform DESIGN DECISION — "visibility everywhere, actuation with the
   holder, transfers are deliberate operator-visible operations" —
   consistent across files (P2 pulls copies, never authority),
   commitments (P1.5 owner-routing), and conversations (this section).
   The beacon-holder OBSERVABLE the deferral needs is NOT prose: it is <!-- tracked: multimachine-coherence-p3-threadline-registry-machine-swap -->
   P1.5's merged commitments view itself (every merged row carries
   `originMachineId` = the machine whose beacon actuates, with
   staleness) — the user on machine B can SEE that a promise's reminders
   live on sleeping machine A. Transfer-of-duty remains OPEN as a
   build-on-demand item: it stays tracked in the P1.5 spec's §2 marker
   and graduates to a real spec only if live operation shows
   silent-beacon pain (Close the Loop: the P1.5 build's live-verify
   includes exercising that visibility, which is the re-surfacing
   cadence). P3 does NOT claim to close it.

### 3.4 Config & rollout

Rides the same `replication.enabled === true` gate (the kind replicates
only where journal replication runs; emission itself is harmless and
always-on with the journal, like the other kinds). Tunables: none new —
the kind inherits journal retention/rate-cap config keys
(`coherenceJournal.retention['threadline-conversation']`). Registry: the existing `coherence-journal` category
(src/data/state-coherence-registry.json, paths
`["state/coherence-journal/"]`) covers the new stream files by directory
prefix; the census `threadline` category description gains a note that
holder visibility is fulfilled by this kind. Agent Awareness, ALL THREE surfaces (the
feature-delivery-completeness gate enforces this): the CLAUDE.md
template (generateClaudeMd) + migrateClaudeMd content-sniffed section +
the `migrateFrameworkShadowCapabilities` markers[] entry (Codex/Gemini
agents must learn the trigger too), with the featureSections tracking
registration — the P2 working-set entry at PostUpdateMigrator.ts:2874 +
:4779 is the wiring precedent. Retention lands as the
`threadline-conversation` key in the ConfigDefaults coherenceJournal
retention literal (applyDefaults add-missing backfills existing agents —
the P2 §3.7 pattern; no bespoke migrator step needed).

## 4. Degradation requirements (inherited, plus)

1. Emission failure never affects the conversation operation (journal
   invariant: observability never endangers the observed).
2. A replica-derived answer always carries holder + staleness IN THE
   WORDING ("as of <recvTs>…"); an unreachable holder is named, never
   masked, and the delivery expectation quoted is the relay queue's REAL
   bound (in-memory, ~24h, droppable), never an unbounded promise.
3. Old peers ignore the unknown kind (P1 rule); mixed-version mesh
   degrades to local-only visibility, never errors.

## 5. Security

- Content-free schema (typed, free text structurally excluded).
- **Relationship-metadata disclosure — a NEW class, reasoned not
  hand-waved (round 1):** replicating peer fingerprints aggregates the
  agent's A2A SOCIAL GRAPH (which counterparties, how many threads) onto
  every mesh machine. "Fingerprints are envelope metadata" does NOT
  cover this — envelope visibility shows ONE counterparty its own
  thread; aggregation is different data. And unlike P1/P2's disclosures
  (the operator's OWN files), this payload describes NON-OPERATOR third
  parties — the same asymmetry §1 names for content. Accepted residual,
  stated: every recipient is the operator's own registered machine, the
  graph is the operator's own activity record, and content/titles never
  replicate — acceptable under same-operator, EXPLICITLY a distinct
  disclosure class from own-files, re-evaluated before any
  non-same-operator peer or relay class exists. Retention rides the
  kind's journal retention.
- No new mesh verbs, no new mutation paths — P3.1 rides P1's transport
  and trust model wholesale (first-hop, signed, incarnation-fenced).
- The convenience read is Bearer-gated like every /threadline route.

## 6. Testing (all three tiers)

- **Unit:** schema validation (unknown fields counted, free text
  rejected); emission at each chokepoint with op-key dedupe; the
  current-state fold (started→bound→closed ordering, last-writer wins,
  own-authoritative); holder/staleness tags.
- **Integration:** the kind round-trips the REAL journal-sync transport
  (reuse the P1 harness with the new kind); `GET /threadline/
  conversations?scope=mesh` over real own+replica streams; old-reader
  ignores the kind.
- **E2E (production-shaped, feature-alive):** the 200-not-503 assertion
  FIRST — `GET /threadline/conversations?scope=mesh` answers 200 on the
  production-init path (and degrades to own-rows-only, still 200, when
  replication is dark). Then: machine A creates + binds a
  conversation → B's merged view names A as holder with the binding →
  topic moves to B → B still names A as holder (the swap semantics) →
  close on A → B's view converges.
- **Wiring-integrity:** the ConversationStore seam emits through the real
  journal (observed via stream files, not mocks).

## 7. Work breakdown

1. **P3.1** the kind (JOURNAL_KINDS + schema + retention) + store-seam
   emissions + the convenience read + unit/integration.
2. **P3.2** the swap-semantics surfaces (CLAUDE.md trigger + migrate) +
   e2e + live two-machine verify on the echo pair (bind a quiet test
   conversation, move its topic, ask the OTHER machine where it lives).

## 8. Open questions for Justin

None — P3 deliberately adds no new transport, no new stores, and no new
mutation paths; it is the P1 machinery carrying one more kind plus honest
answers about machine-bound things that deliberately don't move.
