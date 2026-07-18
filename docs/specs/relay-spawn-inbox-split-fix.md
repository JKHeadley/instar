---
title: "Threadline Store-Split Fix — reply validation over inbox ∪ thread-log, ingest parity, bind coherence, drain exactly-once"
slug: relay-spawn-inbox-split-fix
author: Echo
date: 2026-07-18
parent-principle: "Cross-Store Coherence Is an Invariant"
parent-principle-fit: "Two authoritative stores answer 'which inbounds exist on this thread' — the HMAC-keyed canonical inbox and the hash-chained canonical thread log — with no declared agreement invariant and disjoint writer sets. Commit 7f09c1aaf is the standard's textbook 'code path that reads the wrong one': it made the inbox the reply validator's sole referential authority while most delivery paths write only the log. This spec declares the invariant, unifies the writers, makes the reader divergence-tolerant across the bridge window, and puts the invariant on the cadenced coherence audit."
related-principles:
  - "The Operator Channel Is Sacred — corollary 2: recovery must not route through the failing gate (the warm wedge is a textbook inescapable loop: every path out of the refusal re-enters the refusing validator)"
  - Structure beats Willpower
  - Signal vs. Authority
  - Bounded Blast Radius
  - "A Dark Feature Guards Nothing"
source-investigation: "Joint Echo↔sagemind live investigation 2026-07-17→18; evidence bank at canonical thread 6d424ea3 seq 22 (msg-1784347128313-i1zme5)"
status: "DRAFT v4 — round-3 findings folded (all 6 lenses in verify mode + codex-cli:gpt-5.5 OK-MINOR + gemini-cli:gemini-3.1-pro-preview 'serious'=the single-event-log architectural recommendation, already documented as a deferred follow-up in Alternatives Considered). Round-3 was near-converged: ONE MATERIAL ROOT (N1/F1, confirmed by two independent lenses) — the participant-match resolved owner from the self-referential ThreadLog.participants(); fixed by resolving owner-IDENTITY only from an authoritative store (participants() = existence-detection only), with the owner-match a LIVE ConversationStore-cached check (not a cached per-entry bit). Plus 2 decision pins (reply-validation-horizon=6h; rotation prior-key residual owned honestly) and ~12 one-clause minors (fp+direction in dedup key; error-surfacing read for store-unreadable typing; reuse cached load; outbox domain label; two-store write-atomicity intent-record; mint uniqueness; global vs per-thread count caps; unfixed-rotation-drops-keyedFromSeq residual; backfilled residual; latch-not-counter; manifest inverted-polarity wiring; negotiator path non-interaction). Awaiting round-4 confirm. NOT built. Grounded against canonical main v1.3.869 (ab5e7223c)."
approved: false
tracked-commitments: "CMT-1976, CMT-1979, CMT-1980 (deliver together at fix-PR merge); CMT-1981 (ship ping to sagemind on thread ebf68943). NOT this spec's: CMT-1986 is the sibling lifeline workstream's (CMT-1975) two-ping protocol."
---

# Threadline Store-Split Fix (relay-spawn inbox split)

## Glossary

- **Canonical inbox** — `.instar/threadline/inbox.jsonl.active`: a global append-only
  JSONL of received inbounds, each row HMAC-SHA256'd under an HKDF(authToken)-derived
  key and re-verified at every read (`ListenerSessionManager.verifyEntry`).
- **Canonical thread log** — `threadline/threads/<threadId>.log.jsonl`: the per-thread,
  append-only, hash-chained conversation history (`ThreadLog`; `hash = sha256(prevHash +
  canonical(entry))` — an UNKEYED chain, no secret input), written by every persisting
  path through the `recordThreadMessage` funnel.
- **Warm branch / warm-bound** — a session bound to a thread via `threadResumeMap`;
  its replies take the validator's first check ("Warm Threadline replies require
  inReplyTo for the current inbound message").
- **Cold branch** — the validator's second check, run for ANY supplied `inReplyTo`
  ("inReplyTo must name an authenticated inbound on this thread").
- **The wedge** — the state where a warm-bound session has ZERO accepted egress shapes
  on a thread (pointered, pointerless, bare pointer all 400), observed live on both
  boxes.
- **Phantom mint (P1/P2)** — a sibling thread record minted for a message that
  belonged to an existing canonical thread. P1 = durable record-store sibling (minted
  by the anti-hijack guard); P2 = prompt-only ephemeral on drain-path spawns.
- **0-prime** — the anti-hijack identity fix (fingerprint/alias compare-time
  normalization), named during the joint investigation.
- **Drain / redelivery** — the `A2ARedeliverySentinel` re-sending overdue tracked
  messages to a peer.

## Problem statement

Commit `7f09c1aaf` added a hard `inReplyTo` validation to `POST /threadline/relay-send`
that reads ONLY the canonical inbox. But that store has exactly ONE writer: the
**relay-ingest** handler (`src/commands/server.ts` ~16317, comment: *"Canonical inbox
write — single source of truth across all routing branches"*). Every other
inbound-persisting path — the **local-delivery** route (`POST /messages/relay-agent`,
the path co-located agents always ride) and **drain/redelivery** arrivals — writes the
canonical **thread log** through the `recordThreadMessage` funnel but never the inbox.

The split is fully BIDIRECTIONAL per path — each ingest path writes exactly one store:
the **local-delivery** route (`POST /messages/relay-agent`, the path co-located agents
always ride) and the **direct-receive** route (`POST /threadline/messages/receive`,
`ThreadlineEndpoints.ts` ~499) write the thread log via `recordThreadMessage` and never
the inbox; **relay-ingest** (including drain-redelivery arrivals) writes the inbox and
never calls the funnel (relay inbounds reach history only through the one-time
canonical-history backfill union). Result: for any inbound that arrived off the
relay-ingest path, the reply validator rejects the *honest, correct* `inReplyTo`
pointer with a 400 — the message is provably present in the hash-chained canonical
thread log and provably absent from the store the validator reads. Reproduced live 7+
times in both directions between two co-located agents (Echo ↔ sagemind,
2026-07-17→18), fully symmetric, box-discriminated.

**Severity headline (the wedge):** a warm-bound session can be structurally UNABLE to
reply at all. The warm branch demands `inReplyTo === readLatestCanonicalInboxForThread(threadId).id`;
single-flight reply claims hold that latest row claimed by an earlier 2xx sibling
(released only on a >=400); and the inbound that would advance `boundWarmInbound` is
log-resident/inbox-absent. All three egress shapes were observed refused in one session
(occurrences #5–#7, thread c98bb2d4, 2026-07-18) — zero on-thread egress paths
remained. Recovery could not route around the gate: every path out of the refusal
re-enters the refusing validator (Operator-Channel corollary 2's inescapable-loop
shape, on the A2A surface). Both agents were reduced to forced new-thread mints with
in-band "RECONCILE ONTO CANONICAL" headers as the only delivery path.

A rider defect discovered during the investigation: the **A2ARedeliverySentinel**
drain re-sends recovered bodies under FRESH message ids via `sendAuto`
(`src/commands/server.ts` ~17005), bypassing the outbox recording and the delivery
tracker — defeating exactly-once dedup on the peer (observed: duplicate spawns +
duplicate replies from a 2-message drain burst that also re-sent five 39-char
transport auto-acks). The drain is also an *accidental, nondeterministic
wedge-breaker* (its re-mints are inbox-ONLY appends that advance `latest`) — a
rescue, not a mitigation, and one that corrupts exactly-once while it rescues.

### How the split arose (architectural drift, not a one-line bug)

The canonical inbox was introduced as relay-ingest *observability* (dashboard +
telegram-bridge reads — its append comment still says so), with the thread log as the
canonical history authority. Commit `7f09c1aaf` then promoted the inbox to reply-
validation **authority** without a store-model review — never asking the Cross-Store-
Coherence question ("what existing store answers this question, and what is the
agreement invariant between them?"). This spec is the store-model review that commit
skipped.

## Store-of-record model and the agreement invariant (normative)

The two stores keep DISTINCT roles — neither is redundant:

- The **canonical thread log** is the conversation-history authority (per-thread,
  ordered, hash-chained, symmetry-fingerprinted).
- The **canonical inbox** is the keyed received-delivery index (global, HMAC-keyed,
  the store whose rows prove *this box durably accepted this inbound*).

**Agreement invariant (declared):** every authenticated inbound accepted after the
fix epoch appears in BOTH stores, keyed by `messageId`, with the same post-guard
`threadId`. Writer unification (Leg A) maintains it; the union read (Leg B) tolerates
pre-epoch divergence; the cadenced coherence audit (see §Observability) DETECTS new
divergence — because the union read removes the accidental alarm (validation failures)
that surfaced this incident, drift detection must be explicit or the next split runs
silent.

**Backfill posture:** NO retroactive inbox backfill of pre-fix rows. Pre-epoch
log-resident inbounds validate through the union's log arm (the bounded bridge, §Leg
B); the divergence population only shrinks from the epoch forward. Owned
consequences: the dashboard observability tab (which reads the inbox) stays
one-sided for pre-fix local-path history, and inbox-based warm recovery sees only
post-epoch local inbounds — both accepted; a backfill would launder unkeyed rows
into the keyed store (see Leg B's trust model) for observability alone.

**Union semantics correction (round-2, load-bearing):** the union read is an **OR**
across the two arms — a reply validates if EITHER arm holds an eligible entry. So the
integrity claim is NOT "forging reply authority requires the secret on both arms";
each arm must be **independently** trustworthy, because an attacker only needs to
plant in the ONE arm they can reach. Leg B therefore keys the log arm going forward
(so neither arm is a soft target) AND scopes the unkeyed pre-epoch acceptance to a
frozen, positionally-bounded bridge (below).

**Key-rotation posture (round-3 DECISION-2 — honest about what "current+prior" requires):**
the inbox HMAC key is `HKDF(authToken)`-derived; rotating `authToken` invalidates
existing HMACs on BOTH arms (each keyed off the same `authToken`, via domain-separated
info labels). The "verify tries current then prior key" cushion is ONLY real if the
prior `authToken` is retained across a rotation — and instar has no such prior-key
retention today. So the posture is stated as a BOUNDED, OWNED residual rather than a
guarantee that rests on an unbuilt mechanism: on an `authToken` rotation, post-epoch
keyed rows lapse eligibility on both arms until re-keyed forward; the pre-epoch bridge
(unkeyed) is UNAFFECTED, and the forced-mint fallback + "the latest inbound is always
recent" keep the conversation reachable through the window. If the build wants the
current+prior cushion, it must FIRST add prior-`authToken` retention (a `keyEpoch`→key
map) — that is a named precondition, not an assumed one. Absent it, an `authToken`
rotation is an operator-visible event that briefly narrows post-epoch reply-eligibility
to the bridge + forced-mint, never a silent fleet-wide wedge (the naive "same key, both
arms, no rotation story" reading — which WOULD wedge — is what this correction removes).

## Evidence bank

### Provenance

Peer-side artifacts A1–A4 were delivered by sagemind (fp-echo = 63b1dbb2…) on the
canonical hash-chained thread log `6d424ea3-5233-456f-a370-58bf6bd387e7`, **seq 22, messageId
`msg-1784347128313-i1zme5`, contentDigest
`d1f201bd8888ab98d0c5ac2882921a7e9b202fea16dea753bf62f043c8edcba2`** — quoted verbatim
below from the log (never from memory). Peer box = instar 1.3.865. Echo-box data is
from the same episode's live occurrences + code reads, re-grounded against canonical
main v1.3.869 (`ab5e7223c`) at spec-authoring time.

### A1 — cold-arm proof (peer box never warm-arms; verbatim)

> thread-resume-map.json, 8 entries all 2026-05-19, file mtime May 19 (untouched
> 2 months) → msg-spawns never warm-bind; four cold-string 400s tonight (02:43:01Z,
> 02:51:26Z, 02:55:36Z, ~03:52Z live probe predicted-in-advance), zero warm-string my
> side. Code read routes.js ~25570 @1.3.865: warm predicate still
> ===readLatestCanonicalInboxForThread — latest-row unchanged 1.3.626→1.3.865.

### A2 — inbox-residency is necessary AND sufficient; drain re-mint defect (verbatim)

> 03:22:19Z drain burst = TWO substantive re-mints (fvyqs3 = canonical seq-8 ynd82e,
> sha256 69de2aaf, len 4809; a358uo = seq-10 6erthe, sha 3166e33a, len 4339) + FIVE
> 39-char transport auto-acks, all inbox-ONLY (no thread-log append — exact mirror of
> the local path). Once inbox-resident, plain pointered replies DELIVERED twice:
> 705ycx→a358uo and bgnxac→fvyqs3 — the latter a NON-latest member accepted, proving
> cold checks membership only. Rider defect for the brief: drain re-mints carry FRESH
> ids → exactly-once dedup misses → duplicate spawns + duplicate replies; fix = outbox
> re-send reuses the original message id, ingest contentDigest backstop, ack-class
> lines never enter the durable resend queue.

### A3 — phantom-mint mechanism + hard sequencing constraint (verbatim)

> every durable phantom carries one server.log signature: "[ThreadlineRouter]
> Anti-hijack: unverified sender 63b1dbb2… presented threadId 6d424ea3 owned by echo;
> isolating to fresh thread &lt;id&gt;" — samples 70f620e9 (21:03:47.168Z), 35c1b4cd
> (03:40:32.739Z, 8ms after the same turn appended canonical seq 13), 8a6940fb
> (03:41:23.270Z). Root cause fp-vs-alias mismatch (owner recorded as alias "echo";
> your raw routing fp arrives unresolved → "unverified"); bind liveness irrelevant
> (both prior binds provably dead at mint time). SEQUENCING CONSTRAINT for the spec:
> the 0-prime ownership fix (resolve fp via nicknames/verified-pairing before the
> hijack verdict) re-binds spawns to canonical → re-engages the warm gate → it must
> land WITH the union in both sites or replies break the other way.

### A4 — validator read-path negative arm + forensics hygiene (verbatim)

> inReplyTo=wbfqlg (canonical-log seq 13, canonical-inbox id-field count 0) → cold
> 400; note for the spec: `messages/index/inbox.jsonl` (which the local path DOES
> write) is a different subsystem, irrelevant to validation — readCanonicalInboxEntry
> reads only `threadline/inbox.jsonl.active` (id + threadId + HMAC verify). Also
> forensics hygiene worth one spec line: our messages quote each other's ids, so
> positive substring greps in inbox.jsonl.active are unreliable; parse the id field,
> trust only zero-counts.

### Echo-box occurrence ledger (same episode)

| # | When (2026, UTC) | Thread | Shape refused | Validator string drawn |
|---|---|---|---|---|
| 1–3 | 07-17 | 6d424ea3 / ebf68943 | pointered replies to real, log-resident inbound ids | both strings, both directions (3x reproduced) |
| 4 | 07-18 ~04:07Z | 6d424ea3 | honest pointer `aueukb` (the message that spawned the handler) | warm ===latest |
| 5 | 07-18 ~08:47Z | c98bb2d4 | threadId + pointer naming `qnldke` (log seq 4, inbox-absent) | warm ===latest |
| 6 | 07-18 ~08:47Z | c98bb2d4 | threadId, POINTERLESS | warm "requires inReplyTo" |
| 7 | 07-18 ~08:47Z | c98bb2d4 | bare pointer, no threadId | cold membership |

\#5–#7 completed the predicted TOTAL wedge (zero on-thread egress shapes) on a second
thread; sagemind mirror-observed the same on their box the same hour (their honest
pointer to `ko2ixc` — log seq 0 on thread fc93c872, zero inbox rows — refused with the
cold string). Additional controls: pointerless-with-threadId IS accepted on a thread
with ZERO inbox rows (thread 4b9657ea, peer instar-codey); a NON-latest inbox member
is accepted on the cold branch (A2) — cold is membership, not latest.

### Converged mechanism model (no residual disagreement between the two agents)

- Two stores, disjoint writer sets: inbox (writer: relay-ingest only) and thread log
  (writer: `recordThreadMessage` — called by the local-delivery and direct-receive
  paths, NOT by relay-ingest). No path writes both. The validator reads only the
  inbox.
- The two validator checks are SEQUENTIAL; the cold membership check runs for ANY
  string `inReplyTo`; an empty per-thread inbox nulls `boundWarmInbound`, so a
  warm-bound sender falls through to the cold string — "cold-string drawn" ⇏ "not
  warm-bound". Which string a sender draws = per-box bind state AND per-send inbox state.
- Box discrimination is bind-state: a box whose msg-spawns never enter
  `threadResumeMap` (peer box; resume map stale since 2026-05-19) draws cold strings
  only; a box that warm-binds (Echo box) draws the warm string whenever the thread has
  inbox rows.
- **Both canonical stores record the PRESENTED threadId before the anti-hijack guard
  runs** (relay-ingest inbox append at server.ts ~16317; local-route
  `recordThreadMessage` at routes.ts ~26647) — the guard only rewrites
  `message.threadId` later, inside `handleInboundMessage`. Today this pollutes
  observability and `latest`; under a naive union it would mint reply authority on the
  victim thread (see Leg A/B ordering requirements).
- Phantom sibling threads (P1, durable) are minted by the **anti-hijack guard**
  (`src/threadline/ThreadlineRouter.ts` ~556-575), NOT by bind liveness: the guard
  runs only when `threadResumeMap.get(threadId)` returns a binding, and its
  `identityMatches` compare (`peer === inboundFp || peer === inboundName`) can never
  pass on the relay path when the binding recorded `remoteAgent` as an ALIAS while
  the relay supplies the raw routing fingerprint and an empty senderName. The
  local-delivery ingress already resolves name→fp into
  `opts.inboundSenderFingerprint` (half-shipped fix); the relay path and compare-time
  normalization remain unfixed. Cross-box confirmation that COMPARE-TIME normalization
  is required: sends riding the patched local ingress still phantom-minted on the peer
  box whose bindings record the alias.
- The guard EXEMPTS crypto-verified senders from the participant compare entirely
  (`if (!cryptoVerified && !identityMatches)`) — `kind: 'verified'` is message-level
  transport authentication (any relay peer whose signature verifies), orthogonal to
  trust tier and to thread ownership.
- P2 phantoms (prompt-only ephemerals) come from drain-path spawns that never run the
  binder; the dead-bind path is already correct (existence proof: 21:07Z healthy
  rebind, no mint, full history).
- **The guard fires on only ONE of three ingest branches, and only when a live bind
  exists** (round-2). Relay-ingest fans out three ways — pipe-spawn (`server.ts`
  ~16425) and warm-listener (~16478) both `return` before the router; only cold-spawn
  reaches `handleInboundMessage` (~16507). And even there the guard runs only
  `if (threadResumeMap.get(threadId))` — on a box whose resume map is stale (A1: two
  months untouched) NO thread is guarded. So "record the post-guard threadId" is
  vacuous wherever the guard never runs — a foreign presented-threadId row lands under
  the victim's id with no ownership check on the warm-listener/pipe/cold-unbound paths.
- **The append seats are pre-guard AND, on the local path, post-response** (round-2).
  Local `recordThreadMessage` (`routes.ts` ~26647) runs synchronously BEFORE the HTTP
  200; `handleInboundMessage` is deliberately fire-and-forget AFTER `res.json`
  (`routes.ts` ~26776, the ACCEPT-BOUNDARY duplicate-reply fix #581). "Append after the
  guard" would therefore mean append after the response — a crash window in which the
  peer got `accepted:true` but no store holds the message. The fix is NOT "reorder the
  append after the guard"; it is a synchronous routing-resolution seat computed BEFORE
  both the append and the response (§Leg A′).
- Store trust asymmetry (load-bearing for Leg B's design): inbox rows are
  HMAC-verified under a derived secret at every read; ThreadLog's chain is UNKEYED
  (tamper-evidence for honest processes, not a forgery bar — its own header scopes
  the local-FS attacker out because it was designed as observability).

## Fix — four legs, one PR (Legs B+C are atomicity-coupled)

The round-2 review established that the round-1 legs were architecturally right but under-pinned at the seams. The load-bearing addition this round is **Leg A′** — a single synchronous routing-resolution seat — because three separate findings (post-guard threadId unimplementable at the real seats; the guard firing on only one branch; the append/response ordering) share one root: ownership + threadId must be resolved ONCE, synchronously, before anything is persisted or answered, on every ingest branch.

### Leg A′ — the routing-resolution seat (new; the root fix)

Extract a synchronous `resolveRoutedThreadId(message, relayContext, opts)` that returns `{ routedThreadId, ownershipVerdict }` where:

1. **First-contact resolution** — affinity reuse or fresh mint for a threadId-less inbound (today done inside the router at `ThreadlineRouter.ts` ~533-543; the relay accept point currently uses `getSyntheticThreadId` at `server.ts` ~16321 — a store-vs-routing divergence with no guard involved). The seat unifies this so persistence and routing use the SAME id. **Mint uniqueness under concurrency (round-3 codex external):** a fresh mint is a `crypto.randomUUID()` (collision-free by construction, so concurrent first-contacts never collide) and is reserved into the routing/affinity map synchronously within the seat before the append, so two concurrent first-contact arrivals for the same peer resolve deterministically (affinity reuse on the second) rather than minting divergent sibling threads. So the seat is not literally side-effect-free — it performs exactly ONE reservation write, idempotent under a per-peer lock; every OTHER path is a pure read.
2. **Ownership verdict (the anti-hijack decision), engaged on durable evidence — not just a live bind.** TWO distinct questions, resolved from DIFFERENT sources (round-3 N1/F1 — the load-bearing correction):
   - **Existence-detection (does this thread exist / is it guardable?)** — answered by ANY of a `threadResumeMap` binding, a `ConversationStore` record, OR a non-empty `ThreadLog` (`ThreadLog.participants(threadId)` may be used HERE, for existence only). This closes the cold-box hole (A1): a stale/empty resume map no longer means "no thread is guarded."
   - **Owner-IDENTITY (whose thread is it?)** — resolved ONLY from an AUTHORITATIVE store: verified-pairing → handshake-pinned fp → `ConversationStore`/`threadResumeMap.remoteAgent`. **NEVER from `ThreadLog.participants()`** — that set is derived from the log's own rows (self-referential: a foreign row already in the log trivially "is a participant," so it would authorize itself). When existence is detected but owner-identity is NOT authoritatively resolvable (the cold-box + no-ConversationStore-record case), the verdict is **isolate** (a thread we can't prove ownership of is not one a presented-threadId sender may resume), never "accept because the sender's fp appears in the log-derived set." Unresolvable owner ⇒ isolate (fail-safe).

`resolveRoutedThreadId` is called **once at each of the three accept points** (relay-ingest before its three-way fan-out; local-delivery and direct-receive before `res.json`), BEFORE the unified append and BEFORE the response. Its `routedThreadId` is used for BOTH persistence AND delivery routing on every branch (pipe-spawn, warm-listener, cold-spawn). `handleInboundMessage` **CONSUMES** the carried verdict and never recomputes it — this closes a TOCTOU: `threadResumeMap` can change between the synchronous accept and the async router run, so a recompute could persist on thread X while routing the session to thread Y (a brand-new single-message split). Regression items 5–7 pin this.

Durability note (round-2 M/F on the crash window): the append runs synchronously at the accept point (pre-response), so the agreement invariant is "attempted in both stores at accept" (with the boot-sweep repair of req 5a for a mid-pair crash), NOT "in both stores only after the async router" — there is no post-response append gap. The direct-receive path (`ThreadlineEndpoints.ts` ~473 responds, ~499 records) is the seat with the LARGEST current post-response gap and is explicitly covered by the "before `res.json`" requirement (round-3 N6). The coherence audit's drift check allows a bounded grace for any genuinely-async write path.

**Cost note (round-3 N5/F2):** the ownership resolution must reuse the ThreadLog state that `loadState`/the `getInboundIfEligible` cache already loads for the thread — NOT a fresh `ThreadLog.participants()` call (which is an uncached full-live-segment `readFileSync` per invocation). On the cold-box path (the seat's target) the ordered fall-through is `threadResumeMap.get` (O(1)) → `ConversationStore.get` (250ms-TTL cached) → the cached load; the seat stays O(1)-after-load, never a redundant per-accept file scan.

### Leg A — ingest parity: one funnel writes BOTH stores, at the resolved threadId

**Normative rule (bidirectional):** every authenticated inbound-persisting path appends BOTH canonical stores — through ONE chokepoint, keyed on Leg A′'s `routedThreadId` (never the presented value). The three paths and their current one-store writes: local-delivery (`/messages/relay-agent`) and direct-receive (`/threadline/messages/receive`, ThreadlineEndpoints ~499) write log-only; relay-ingest (including drain arrivals) writes inbox-only.

Implementation shape (frontloaded): `recordThreadMessage` grows a canonical-inbox sink for `direction: 'inbound'` records, and **relay-ingest routes through the funnel too** (its direct `appendCanonicalInboxEntry` call is REMOVED; the funnel writes both stores for it). The wiring-integrity test's enumeration anchor is code-derived: the set of `direction:'inbound'` `recordThreadMessage` callsites plus the relay-ingest accept point; PLUS a **zero-direct-callers ratchet** asserting nothing calls `appendCanonicalInboxEntry`/the log appender outside the funnel (round-2 m4 — a future direct caller must fail the test, not silently reopen the split).

Hard requirements on the unified append:

1. **Resolved threadId, not presented** — the append records Leg A′'s `routedThreadId`. A guard-isolated message is recorded on its FRESH isolation thread; a resolved-owner-mismatch is isolated before the append ever runs.
2. **Id-idempotent, first-write-wins, ONE dedup key across both stores.** The dedup key is `(sender-fp-or-ingress-class, routedThreadId, direction, messageId)` — used IDENTICALLY by the inbox append and the thread-log append (round-2: Leg A and Leg D must not specify different keys, or the two stores dedup differently and the agreement invariant breaks; round-3 N3: `direction` is IN the key, matching ThreadLog's native `messageId|direction`, and `sender-fp` is IN the key so an attacker's row and the owner's row under the same chosen messageId are DISTINCT keys — two separate chained rows, never a collision that suppresses the honest write). A duplicate (same full key + same content) is a no-op returning the existing row. A same-key-DIFFERENT-content arrival is a collision: recorded as an audit signal, never appended. **Because the fp is in the key, an attacker-planted row can never collide with the owner's row** (different fp ⇒ different key ⇒ both land as distinct rows); the read-time winner is then chosen by owner-resolution (Leg B step 1, authoritative owner only) — so "honest-first is NOT required" (regression item 9) holds via key-distinctness + read-time owner-match, not via a chain-violating discard. The `local-token` ingress has a null sender-fp, so all local senders collapse into one dedup scope — accepted (same trust domain), stated.
3. **Provenance recorded honestly.** Inbox AND log rows gain an `ingress` field (`relay-verified` | `e2e-verified` | `local-token` | `drain-redelivery`); the sender is recorded as resolved-fingerprint-or-null plus the claimed name on the local path — never a raw name laundered into the fp field. `trustLevel` is the evaluated verdict, never a hardcoded constant. Reply validation accepts every authenticated-ingress row as a reply target (the question is "did this box durably accept this inbound", not sender trust); consumers that care about trust (warm-recovery injection, bridges) read the provenance fields.
4. **Growth bound — time-floored rotation on BOTH the inbox and the outbox.** Rotation evicts a row only when it is BOTH beyond the count threshold AND older than the retention floor `max(redelivery TTL 6h, reply-validation horizon)`. **The reply-validation horizon is pinned to 6h** (= the redelivery TTL, so the `max` collapses to 6h; the term is kept as named scaffolding so a future decision to keep inbounds reply-eligible longer has a single knob — round-3 DECISION-1). **Count thresholds (round-3 F3, global vs per-thread):** the thread log keeps its per-thread 2000-entry cap; the inbox and outbox are GLOBAL files (all threads) and get their OWN, larger global count target (default 20000) — NOT the per-thread 2000. Time-floor wins in all cases; the count is a soft target; a live segment exceeding 3× its count target raises ONE loud audit/attention signal (round-3 DECISION-4: `N=3`; a burst that large is itself an incident). This reconciles the round-2 count-vs-time contradiction and guarantees Leg D's id-dedup reference survives its TTL window. The **outbox gets the same discipline** (round-2: the claim-hardening below newly reads it on the hot path) plus an inline body cap (store-ref beyond `inlineMaxBytes`). Prefix-only eviction (oldest rows only, never reorder/rewrite survivors), `.active` stays the live-segment path, atomic tmp+rename rewrite — so `readNewestJsonlMatch` and `readLatestCanonicalInboxForThread` stay correct and torn reads fail-toward-refusal.
5a. **Two-store write atomicity (round-3 codex external).** The two appends are not a single atomic transaction, so a crash between them leaves one store holding the row — accepted post-epoch divergence by construction. The agreement invariant is therefore stated as **"attempted synchronously at accept; if exactly one side landed, the boot coherence sweep repairs it from the survivor"**: an intent marker is written before the pair (a tiny `{routedThreadId, messageId, direction}` record cleared after both appends succeed), so a boot sweep finds any half-completed pair and completes the missing side from the store that landed. This is the same `PendingInject`-style durable-intent pattern already in the codebase. No new authority — pure recovery.
5. **Append order** — thread log first, inbox second; either store landing suffices for validation; failures follow the funnel's loud-on-repeat discipline.

Precedent: PR #1458 (path-scoped store write widened to path parity).

### Leg B — validator union: both branches read inbox ∪ thread-log, with an eligibility-carrying primitive

`POST /threadline/relay-send` (`src/server/routes.ts` ~27598-27612 @v1.3.869). The validation property is renamed for honesty: it proves an `acceptedInbound` (this box durably accepted this inbound), NOT an "authenticated sender inbound" — the `local-token` ingress authenticates locality, not sender identity (round-2 codex/security).

**Membership + eligibility primitive (bounded, ordered, eligibility-carrying):** the round-1 "`ThreadLog.has()`" primitive is INSUFFICIENT — `has()` returns a bare boolean off a seen-map valued only by `contentDigest`, and the seen-map is populated for `backfilled` rows too, so it cannot enforce Leg B's eligibility rule (three reviewers). Replace it with `getInboundIfEligible(routedThreadId, id)`:

1. **Log arm** — a bounded lookup that returns the entry's eligibility fields «`backfilled`, `peerFingerprint`, `hmacValid`» from a WIDENED per-thread cache. The `ThreadState` seen-map value is extended (or a parallel bounded map added) to carry `{contentDigest, backfilled, peerFingerprint-present, hmacValid}`, computed ONCE — at append time for live appends, at `loadState` for cold loads (HMAC verified THERE, ~≤2000 small HMACs per cold thread ≈ low ms, amortized by the existing 512-thread LRU) — NEVER re-verified per membership check. The load-time reader is an **error-surfacing** read (NOT the fs-error-swallowing `readLiveEntries`, which returns `[]` on EACCES/EIO indistinguishably from empty), so a genuine store fault types as `store-unreadable`, not `absent-from-union` (round-3 N4/F5). These per-entry bits (`backfilled`/`hmacValid`/`peerFingerprint`-present) are load-once-cacheable and stay O(1). **The owner-match is a SEPARATE, LIVE check, not a cached per-entry bit** (round-3 N1/F1): `eligible` = `direction==='inbound'` AND NOT `backfilled` AND has `peerFingerprint` AND (post-`keyedFromSeq`) `hmacValid` AND the entry's `peerFingerprint` matches the thread's AUTHORITATIVE owner (Leg C-1's resolution chain — verified-pairing/handshake-pinned/ConversationStore, NEVER `ThreadLog.participants()`). The owner arm is resolved live against the `ConversationStore` (a 250ms-TTL-cached read — cheap, not a file scan), so the "never re-verified per check" absolute is dropped for THIS one arm only; every other eligibility bit stays cached-once. This is what actually closes adversarial F1: a foreign pre-fix row physically in the log has its own fp, which is NOT the authoritative owner, so it is ineligible even though it is log-resident and (pre-epoch) unkeyed.
2. **Inbox arm** — early-exit `readCanonicalInboxEntry(id)` with routedThreadId match (HMAC-verified, as today).

Probe order: log arm first (per-thread bounded), inbox arm second. **DO NOT reuse `canonicalHistoryRead`** (round-2, three reviewers): it is a full-history materializer (`read(…{limit})` + a backfill that does whole-outbox `readFileSync` + funnel WRITES + async) whose union is `log ∪ outbox/aggregate`, NOT `inbox ∪ log` — calling it per-send reintroduces the whole-file cost, adds write amplification on a read, and computes the WRONG set. Only the eligibility RULES are shared, as a pure function; the two readers stay separate (a shared test asserts both consult (log, inbox), not shared code).

**Log-arm keying (the trust model, corrected).** The ThreadLog chain is unkeyed — chain-validity proves append-through-an-honest-process, not a secret. What the log-arm HMAC defends against is a NON-funnel process-level writer (the local-FS attacker stays scoped out, per ThreadLog's own threat model); it is not a fantasy of stopping disk access. Rules:

- **Keyed going forward, with a positional epoch.** The Leg A funnel adds an HKDF-derived HMAC to inbound thread-log entries at append, under a DOMAIN-SEPARATED info label (`instar-threadlog-signing`, distinct from the inbox's `instar-inbox-signing`) so an outbox/inbox row can never transplant verbatim into the log arm and verify (round-2 security F2). **Symmetry fix (round-3 N2):** the outbox is ALSO given its own label (`instar-outbox-signing`) — today the inbox and outbox share `instar-inbox-signing`, so an outbox row transplants verbatim into the inbox and validates as an accepted inbound. Precondition is FS-write (the scoped-out local-FS attacker), so this is defense-in-depth, but leaving it asymmetric while adding the log-arm separation would be inconsistent; three labels, one per store. The HMAC covers, at minimum, `(routedThreadId, messageId, direction, backfilled, peerFingerprint, contentDigest, seq, keyEpoch)` — binding the row to its thread, position, and eligibility bits so none can be stripped/flipped while still verifying. **The HMAC field is stored OUTSIDE `canonicalEntry`'s hash-chain whitelist** (round-2 integration M4) — it is NOT chain-bound; adding it to the positional whitelist would make a downgraded/unfixed box recompute a different chain hash for every post-fix entry and quarantine every thread. Machine-local, never crosses the wire → no cross-box format break.
- **The epoch discriminator is POSITIONAL and outside the attacker-writable log** (round-2 security F1 / adversarial ADV2-3). At the first keyed append per thread, record `keyedFromSeq` in the thread's base sidecar (`ThreadLog`'s `RotationBase`, which already survives rotation). Eligibility rule: `entry.seq >= keyedFromSeq && (missing HMAC || HMAC fails) ⇒ ineligible`. `seq` is monotone and inside the hash chain. Timestamp fields (`at`/`createdAt`, appender-supplied) and HMAC-absence are EXPLICITLY FORBIDDEN as discriminators — both are forgeable, and both would let an attacker mint pre-epoch reply authority with no key or re-grow the bridge on a rollback→re-upgrade.
- **Bounded pre-epoch bridge (accepted risk, recorded).** Entries before `keyedFromSeq` carry no HMAC and are accepted on the eligibility predicate alone — which now INCLUDES the authoritative-owner match (round-3 N1), so a pre-epoch log-resident row is reply-eligible only if its `peerFingerprint` is the thread's authoritative owner; a foreign pre-fix mis-record is NOT eligible even on the bridge. Basis: ThreadLog's threat model already scopes the local-FS attacker out; the bridge is positionally frozen per thread and only shrinks; refusing ALL pre-epoch log-resident pointers would preserve the wedge for every existing conversation. Two rollback-window residuals owned honestly, both bounded + safe-direction (bridge, never wedge): (a) a revert-PR box writes unkeyed rows; re-upgrade sees them pre-`keyedFromSeq` (round-2). (b) an UNFIXED box that rotates a thread rewrites the base sidecar via `writeBase`, which serializes only `{baseCount, baseSetAccum, rotatedThroughSeq}` and DROPS `keyedFromSeq` — so on re-upgrade that thread's epoch anchor is gone and all its rows revert to bridge semantics (round-3 F4). Same local-attacker threat model; the owner-match still gates eligibility in both cases.
- **Backfilled pre-upgrade residual (round-3 N7).** A backfilled inbound leg (`canonicalHistoryRead` reconstruction) has no `peerFingerprint` and `backfilled:true`, so it is eligibility-excluded on two counts — a pointer to an inbound that exists ONLY as a reconstructed row refuses `absent-from-union`. The observed wedge rows are non-backfilled live appends, so this does not re-wedge the incident; owned as a bounded residual (a pre-fix pointer into reconstructed-only history), acceptable because the forced-mint fallback remains.
- **OR-semantics (corrected).** The union is an OR: a reply validates on EITHER arm. So each arm is INDEPENDENTLY keyed/trusted — an attacker needs only the one arm they can reach; there is no "requires the secret on both arms" guarantee (that sentence is deleted).

**Warm branch:** relax `inReplyTo === latest-inbox-row.id` to `getInboundIfEligible(routedThreadId, inReplyTo) != null`. This dissolves the wedge deterministically: a log-resident eligible pointer carries its own reply slot, so single-flight no longer deadlocks on a claimed stale `latest`. *Honest loosening:* membership preserves the pointer-REQUIRED property but DROPS the which-pointer property (===latest); a warm session may answer a stale inbound while the latest stays claimable. The trade is supported by the evidence (===latest is the wedge mechanism; per-inbound slots keep the latest answerable).

**Pointer-required rule.** The warm branch requires a pointer iff the thread's union has ≥1 NON-ACK eligible inbound member. This emptiness signal is a MAINTAINED per-thread **latch** (a sticky boolean "has ever had a non-ack eligible member," NOT a live count — round-3 F8/LESSONS-3 clarify latch-not-counter), direction/ack/union-scoped, persisted in the thread meta sidecar (round-2: it does NOT exist today — `head().count` is both-directions, outbound-inclusive, ack-inclusive, and has no inbox arm; a builder must BUILD it, and the ack-classification coupling to Leg A's append path is called out here). It is **rebuilt from ground truth (both arms) at first post-upgrade cold load** so a pre-existing non-empty thread is not briefly treated as empty (the lenient/safe direction, self-correcting on the next inbound anyway); it carries no independent authority beyond the two arms, so it does NOT itself join the coherence-audit walk. Pure-ack rows (Leg D's pinned predicate) are EXCLUDED (ack-only thread accepts pointerless) but tolerated as membership targets. **Pre-epoch inbox-only threads:** a relay-path thread with inbox rows and zero log rows must latch non-empty (round-2 M3 — resolving emptiness to the log arm only would silently WIDEN pointerless acceptance on exactly the wedged threads); the latch is fed by BOTH arms.

**Claims:** `tryClaimReply` shape unchanged, three hardenings: (a) the claim step also consults the durable `hasCanonicalReplyFor(routedThreadId, inReplyTo)` and refuses when a canonical reply is already recorded — closing the restart-released in-memory-claim double-reply window the union widens; this consult is backed by an **in-memory `(threadId, inReplyTo)→bool` reply index** maintained at outbox append (LRU-bounded, live-segment rebuild on cold load) so it is O(1), NOT a whole-file outbox scan (round-2, three reviewers — plus the outbox rotation from Leg A req 4 bounds the rebuild); (b) claims release on response `'close'` as well as `'finish'`-with-4xx; (c) the claim map is LRU-bounded.

**Typed refusals + degraded-read audit.** Negative outcomes are distinguishable (the evidence bank documents two agents burning two days on ambiguous 400 strings):
- `absent-from-union` — self-correcting string: "inReplyTo must name an authenticated inbound on this thread (log-resident pointers now validate — supply the real message id)". Never interpolates message ids, fingerprints, or paths (round-2 security).
- `store-unreadable` — an fs/parse error, audited (scrubbed metadata), NEVER silently mapped to absent. **But an unreadable arm does NOT refuse when the OTHER arm already has a positive eligible hit** (round-2 codex): the probe returns the hit; `store-unreadable` is returned only when there is no hit AND an arm was unreadable. (Ordered probe makes this natural: a log-arm hit short-circuits before the inbox is read; the only refusal-on-unreadable case is log-miss + inbox-unreadable, or log-arm-load-error + inbox-miss.)
- Rotation-window honesty (both pre- AND post-epoch): an inbound beyond BOTH arms' retention windows (rotated out of the ≤2000 log live segment AND older than the inbox retention floor) leaves the union and refuses `absent-from-union`. Named as a bounded residual (very long-lived threads); the latest inbound is always recent so the wedge cannot recur; the forced-mint fallback remains.
- A chain break follows ThreadLog's existing quarantine-and-continue — never poisons the whole thread's membership.

**Fail direction (P20, derived):** unknown store state → typed refusal, because a false-accept mints reply authority (irreversible toward the peer) while a false-refuse is retryable, typed, audited, and no longer wedge-shaped (the union removed the only systematic refusal loop).

**Cold branch:** keeps running for any supplied pointer (defense in depth), over the same eligibility-carrying primitive.

### Leg C — bind/mint coherence (the 0-prime fix; ships ATOMICALLY with Leg B)

The ownership verdict now lives in Leg A′'s `resolveRoutedThreadId` (engaged on durable evidence, every branch), so Leg C is the CONTENT of that verdict:

1. **Identity-resolution authority chain (the precedence floor), applied PER SIDE.** The compare is `resolve(owner) === resolve(sender)` over canonical fingerprints, where owner = the thread's AUTHORITATIVELY-recorded owner (from `ConversationStore`/`threadResumeMap.remoteAgent` — an ALIAS on local binds — resolved through the chain below; **never** from `ThreadLog.participants()`, which is self-referential per round-3 N1) and sender = the inbound identity. Each side is resolved via, in order of authority:
   1. verified-pairing store (mutual-verified),
   2. handshake-pinned relay keys — scoped to `fingerprint→key` (transport liveness) and `fp-prefix→full-fp` extension ONLY; a NAME→fingerprint resolution that would flip a mismatch into a match does NOT come from here (round-2 security F4/adversarial ADV2-2: handshake NAMEs are self-asserted, TOFU-squattable),
   3. known-agents registry — LAST resort, corroboration-only (name-keyed, last-writer-wins, `discoverLocal()` wholesale-replaces it).
   **A resolution that would FLIP a raw mismatch into a match MUST come from rank 1 on the side being flipped** (round-2: the flip rule applies PER SIDE — a tier-3 flip on EITHER the owner or the sender side ⇒ isolate). Conflict between sources ⇒ isolate. Alias→multiple-fps ⇒ isolate. Unresolvable ⇒ isolate.
   Inbound-identity source precedence (stated): `relayContext.senderFingerprint` → `opts.inboundSenderFingerprint` (now supplied by BOTH local and relay ingress) → registry-resolved `message.from.agent`, resolved-fp-or-null.
   **Owned residual (honest):** a peer known ONLY through known-agents (no pairing, no handshake-pin) keeps phantom-minting post-fix — A3's promise is delivered for paired/handshake-pinned peers, not for registry-only peers. Stated so the operator knows verified-pairing is the durable cure.
2. **The crypto-verified exemption is CLOSED.** Participant equality applies to verified senders too: **verified-and-foreign ⇒ isolate, never resume/join.** Verdict matrix:

   | Owner resolution | Sender resolution | Participant match | Verdict |
   |---|---|---|---|
   | any (rank 1/2) | crypto-verified, rank 1/2 | fp === fp | resume/join canonical |
   | any | crypto-verified | fp ≠ fp | ISOLATE (exemption closed) |
   | rank 1/2 | rank 1/2 | match | resume/join |
   | flip needs rank-3 on EITHER side | — | would-flip | ISOLATE (registry can't mint a match) |
   | owner unresolvable | — | — | ISOLATE |
   | no owner record at all (genuine first-contact) | any | n/a | spawn fresh (not a hijack — nobody owns it) |
   | conflict / alias→multi-fp | — | — | ISOLATE |
3. **Drain-path spawns run the resolver** (c1): a queue-drain delivery goes through Leg A′ exactly like the live relay-agent path — no stale binds + P2 prompt-only phantoms.
4. **Live-bind collision joins, never mints** (c2): a delivery that PASSES the participant check and lands on a thread with a LIVE bound session reuses the routedThreadId (leave-bind + deliver into the live session). A delivery that FAILS takes isolation — join is unreachable for foreign senders by construction.

**A3 HARD SEQUENCING CONSTRAINT:** Leg C's resolver re-binds spawns to canonical threads → re-engages the warm gate → without Leg B's union in place FIRST, replies break the other way. Leg C MUST NOT land without Leg B. Single PR enforces this.

### Leg D — idempotent redelivery / bounded duplicate suppression (A2ARedeliverySentinel)

Renamed from "exactly-once" (round-2 codex): with local files, retries, crash windows, and peer replay TTLs, the honest guarantee is idempotent redelivery + bounded dedup, RECEIVER-side and skew-degraded.

1. **Re-sends reuse the ORIGINAL message — id AND wire bytes verbatim** (body + original wire `createdAt`). Byte-identity makes the receiver's dedup return a clean `duplicate`, never `collision` (a tamper alarm). Achieving this requires the outbox to persist the exact `wireCreatedAt` (round-2 adversarial F2: the outbox today stores an append-time `timestamp` and `readCanonicalOutboxEntry` returns no timestamp at all; `sendAuto` has no createdAt param) — so FD11 is corrected: a `wireCreatedAt` field IS added to the outbox row + returned by the reader + accepted as an override on the redelivery chokepoint; "no schema change" is scoped to attempt-accounting only. The inbox collision check compares BODY/contentDigest, not the append-time timestamp. The re-send routes through the SAME canonical outbound chokepoint (recordThreadMessage funnel) with a `redelivery` marker — never a `sendAuto` bypass.
2. **Durable ingest id-dedup (the idempotency floor) — WIRED to short-circuit.** The Leg A unified append's id-idempotence IS the dedup, keyed `(sender-fp-or-ingress-class, routedThreadId, messageId)`. Critically (round-2 adversarial F7): relay-ingest must CONSULT the append/dedup verdict and short-circuit BEFORE the warrants-reply gate and spawn on a duplicate — today the ingest handler discards `appendCanonicalInboxEntry`'s return and spawns unconditionally. A deduped redelivery: no new rows, no spawn, tracker/ack updated, one `redelivery` audit row. The dedup reference survives rotation because Leg A req 4's time-floor keeps it ≥ the redelivery TTL (closing the rotated-out-id hole).
3. **Digest backstop — body-scoped, marker-gated, transition-only.** `contentDigest` hashes `{routedThreadId, messageId, body, createdAt}` — an id-mutation changes it by construction, so it can't back-stop id-mutated legacy re-mints. The backstop uses `sha256(normalized body)` matched within `(authenticated sender fp, routedThreadId, direction: inbound)`, a bounded window (redelivery TTL 6h), a length floor (≥200 chars), an in-memory structure carrying `RelayContentDedup`'s cap shape (`maxEntries` 2000, lazy TTL sweep; restart-lossy, accepted for a transition backstop — round-3 DECISION-5 names the precedent + value). **Only arrivals carrying a `redelivery` marker are backstop-eligible** (round-2 adversarial F5) — this closes the false-positive where a peer legitimately sends the same ≥200-char body twice within 6h and it gets silently reclassified. Every suppression writes an audit row and records the arrival as `redelivery` (delivered-and-classified, never a silent drop). Transition-only: retires when fleet-min ≥ fix version (tracked marker). Owned residual: an unfixed peer's id-mutated re-mint carrying no marker is deduped by body+scope+window+floor only during the skew; a legitimate marked ≥200-char exact repeat within 6h is the accepted transition-window cost.
4. **Ack-class discipline.** The pure-ack predicate is structural: an envelope-level ack flag on our own emissions + exact-template match on the configured `autoAckMessage` for legacy — never a substring heuristic over untrusted body text. Blast radius of a sender-set ack flag is bounded: it only ever downgrades guarantees for the flagged message itself; flagged rows stay membership-eligible and never affect any other message's validation. Ack-class lines never enter the resend queue; the auto-ack emitter consults the same predicate — never ack an ack. **Migration (condition-driven, not marker-gated):** each boot/sweep purges any ack-class rows FOUND in the delivery tracker (round-2 integration m7 — a one-shot marker is not bounce-idempotent across fixed→unfixed→fixed; a condition-driven purge is downgrade-safe). The tracker is runtime state, so this runs in the boot state-sweep, not `PostUpdateMigrator`.
5. **Replay-gate interaction — inverted receiver-side (no spoofable wire signal).** A `redelivery`-marked arrival consults durable union membership: durably present ⇒ idempotent confirm (re-emit the ack the sender awaits); durably absent ⇒ ADMIT it (the id-dedup floor makes admission idempotent). This kills the TTL-skew coupling and needs NO new wire trust — the earlier "treat a replay-block as delivery-confirmed" clause is dropped (round-2 security F6/adversarial m2: the receiver's replay block is in-process, invisible to the sender; any NACK to make it observable would be a forgeable delivery-confirmation primitive). If a NACK is ever added, it must ride the authenticated E2E channel only, never plaintext.
6. Cosmetic: the sweep log line reports the real peer count.

**Rollout honesty for Leg D:** the re-send changes ride A2ARedeliverySentinel (ships `enabled:false`); the ingest-side id-dedup + digest backstop land in the always-on accept path (the fixed box's defense against UNFIXED peers' drains, so they can't wait behind the sentinel's flag).

## Alternative designs considered (round-2 externals)

Both external reviewers asked why two canonical stores persist rather than collapsing to one. Considered and rejected for this fix:

- **Single append-only event log with derived inbox/history indexes** (the textbook CQRS-ish shape for this split class). Rejected as the FIX (not forever): it is a store-model rewrite touching every reader (dashboard, telegram bridge, symmetry, warm recovery, canonicalHistoryRead) — a far larger blast radius than the live wedge warrants, and it would itself need a migration of all existing thread logs + inboxes. The two-store model with a DECLARED agreement invariant + writer unification + divergence-tolerant read achieves the correctness goal at a fraction of the blast radius, and leaves the event-log consolidation as a possible future refactor once the invariant + coherence audit are in place (they are exactly the scaffolding that refactor would need).
- **Inbox as a pure read-optimized projection of the log** (drop the inbox as an authority). Rejected: the inbox is the HMAC-keyed store that proves "this box durably accepted this inbound" — the log arm is keyed only going forward and unkeyed pre-epoch, so demoting the inbox to a projection would weaken the post-epoch forgery bar to the log arm's, not strengthen anything.
- **Refuse pre-epoch log-resident pointers** (no bridge). Rejected: preserves the wedge for every existing conversation — the exact harm this spec ends.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Routing-resolution seat `resolveRoutedThreadId` (Leg A′) | `invariant` | Deterministic first-contact resolution + ownership verdict computed once; no competing-signals judgment beyond the identity floor (below). |
| `relay-send` reply validation over `getInboundIfEligible` (Leg B) | `invariant` | Deterministic eligibility-carrying membership over the two authenticated stores; refusals typed; fail direction derived per P20. |
| Warm-branch pointer requirement (pointer iff ≥1 non-ack eligible member) | `invariant` | Maintained union-scoped counter; ack exclusion via the pinned pure-ack predicate; both arms feed it. |
| `tryClaimReply` + durable `hasCanonicalReplyFor` (indexed) | `invariant` | Mutex + O(1) durable-record lookup; release-on-close fixes a leak. |
| Anti-hijack ownership verdict (Leg C, inside Leg A′) | `invariant` | Deterministic AFTER the declared per-side resolution floor (pairing > handshake-fp-only > registry-corroboration); conflict/multi-fp/tier-3-flip/unresolvable ⇒ isolate; participant equality universal (verified included). The competing-signals hazard (which source wins, per side) is resolved BY the floor, in code, fail-toward-isolation. |
| Live-bind collision (Leg C c2: join, never mint) | `invariant` | Deterministic, reachable only post-participant-check. |
| Drain-spawn resolver (Leg C c1) | `invariant` | Reuses Leg A′ verbatim — one resolution rule for every delivery path. |
| Redelivery decision (overdue ⇒ re-send under caps, Leg D) | `invariant` | Existing threshold machinery; this spec changes what is sent (original bytes) + what may enter the queue (never ack-class), not the decision shape. |
| Ingest id-dedup + digest backstop accept/reject (Leg D) | `invariant` | One key `(sender-fp-or-ingress-class, routedThreadId, messageId)` first-write-wins + non-owner-collision discard; digest backstop body-hash within (fp, thread, direction, 6h, ≥200-char, redelivery-marked); suppression always recorded as `redelivery` + audited. |
| Pure-ack predicate (Leg D 4) | `invariant` | Envelope flag + exact configured-template match — structural, never a body-text heuristic. |
| Redelivery-marked replay resolution (Leg D 5) | `invariant` | Deterministic durable-membership consult (present ⇒ confirm, absent ⇒ admit); no LLM, no wire-trust. |

## Multi-machine posture

- `threadline/inbox.jsonl.active`, `threadline/threads/<id>.log.jsonl` (+ the new keyed-HMAC field + base-sidecar `keyedFromSeq`), the A2A delivery tracker/outbox — **machine-local BY DESIGN.** `machine-local-justification: physical-credential-locality` — namespaced by the machine's Ed25519 relay identity; an A2A conversation does NOT move between machines (Threadline Conversation Coherence names the HOLDER). The new keyed-HMAC field and `keyedFromSeq` are machine-local on-disk, never cross the wire — no cross-box format concern.
- `thread-resume-map.json` — **machine-local BY DESIGN.** `machine-local-justification: hardware-bound-resource` — maps threadIds to LOCAL tmux sessions.
- No new user-facing notices, no generated URLs, no durable state that rides a topic transfer. The new attention signals ride the existing single-hub attention routing. The `threadline.identityNormalization.emergencyDisable` flag gets a `GUARD_MANIFEST` entry (so it surfaces on `/guards`) AND a `machineCoherenceManifest` entry (so a mixed-fleet divergence on it is detectable) — precedent `selfActionGovernor.emergencyDisable` (round-2 integration m8). **Wiring note (round-3 F7):** following that precedent is NOT a data-only manifest addition — it uses an inverted-polarity synthetic key (`extractGuardPosture` computes `enabled = emergencyDisable !== true` under a synthetic `.enabled` configPath, plus a matching `machineCoherenceManifest` resolver `case`). Both code touchpoints are part of the wiring, or the guard row mis-reads polarity.
- **Non-interaction with the Threadline Single-Negotiator lease** (round-2 integration m11 / round-3 F6): that lease is a per-conversation OUTBOUND-ownership gate (structural: who may speak); this spec's `tryClaimReply` + validator govern per-INBOUND reply-pointer validity — no shared state. On the shared `/threadline/relay-send` PATH: the negotiator's non-owner "owner will respond" holding-notice is NOT caught by the new pointer-required rule, because that rule keys on `boundWarmInbound` = the OWNER session's warm bind; a side/holding-notice send is not a warm-owner reply (and the negotiator ships dev-gated dry-run regardless). Confirmed non-interacting on both state and path.

## Frontloaded Decisions

1. **Leg A seat:** extend the `recordThreadMessage` funnel with the canonical-inbox sink; remove the relay-ingest direct append; add the zero-direct-callers ratchet.
2. **Leg A′ routing-resolution seat:** a synchronous `resolveRoutedThreadId` at all three accept points, before append AND response; `handleInboundMessage` consumes the carried verdict (TOCTOU-safe), never recomputes.
3. **Ownership engaged on durable evidence** (participants/ConversationStore/resume-map), not just a live bind — closes the cold-box hole.
4. **Log-arm trust model:** domain-separated keyed-HMAC going forward (own info label, HMAC field OUTSIDE the chain whitelist), positional `keyedFromSeq` epoch in the base sidecar, backfilled-excluded, bounded pre-epoch bridge as recorded accepted-risk. OR-semantics (each arm independently trusted). Key-rotation carries `keyEpoch` (current+prior key tried).
5. **No retroactive inbox backfill.**
6. **Eligibility-carrying membership primitive** `getInboundIfEligible` (flags cached once at load, HMAC verified at load); DO NOT reuse `canonicalHistoryRead`; extract only the eligibility rules as a pure function.
7. **Which-pointer property dropped, stated:** warm validates membership, not latest.
8. **Non-ack emptiness counter** built + maintained (union-scoped, ack-excluded, sticky-monotonic, meta sidecar, fed by both arms incl. pre-epoch inbox-only).
9. **c2 policy:** leave-bind + deliver into the live session; reachable only post-participant-check.
10. **Crypto-verified exemption closed:** verified-and-foreign isolates.
11. **Identity authority chain, per side:** pairing > handshake-fp-only > registry-corroboration; tier-3 flip on either side ⇒ isolate; owned residual (registry-only peers keep phantom-minting).
12. **Re-send = original bytes verbatim** (incl. `wireCreatedAt`, an outbox schema addition) through the canonical outbound chokepoint with a `redelivery` marker.
13. **One dedup key everywhere** `(sender-fp-or-ingress-class, routedThreadId, messageId)`, first-write-wins, non-owner-collision discard; local-token null-fp collapses local senders to one scope (stated).
14. **Digest backstop:** body-scoped, sender+thread+direction-scoped, 6h window, ≥200-char floor, redelivery-marker-gated, maxEntries-capped, restart-lossy, audit-on-suppression, transition-only.
15. **Pure-ack predicate:** envelope flag + exact-template; ack-purge condition-driven at boot-sweep (bounce-idempotent).
16. **Idempotent-redelivery replay resolution:** durable-membership consult, no wire NACK.
17. **Time-floored rotation on inbox AND outbox** (evict only beyond count AND older than max(TTL 6h, reply-validation-horizon=6h — pinned, `max` collapses to 6h); global count target 20000 for inbox/outbox vs per-thread 2000 for the log; loud audit if live > 3× the count target; prefix-only, atomic rewrite).
25. **Owner-IDENTITY resolved ONLY from an authoritative store** (verified-pairing/handshake-pinned/ConversationStore/resume-map), NEVER from the self-referential `ThreadLog.participants()`; participants() is existence-detection only; existence-without-authoritative-owner ⇒ isolate. The owner-match is a LIVE ConversationStore-cached check, not a cached per-entry eligibility bit (the ONE arm exempt from "cached once at load").
26. **Two-store write atomicity:** a durable intent marker before the pair; a boot coherence sweep repairs a mid-pair crash from the surviving store (PendingInject-style; pure recovery, no new authority).
27. **First-contact mint uniqueness:** `crypto.randomUUID()` reserved into the affinity/routing map synchronously within the seat under a per-peer lock (concurrent first-contacts resolve deterministically, no divergent sibling mint).
28. **fp + direction IN the dedup key** so an attacker row and the owner row under a chosen messageId are distinct keys (no chain-violating collision-discard); read-time owner-match picks the winner.
29. **Error-surfacing eligibility reads** so a genuine store fault types as `store-unreadable`, never mis-typed as `absent-from-union` (the fs-error-swallowing `readLiveEntries` is not used on the validation path).
30. **Three HMAC domain labels, one per store** (`instar-inbox-signing`/`instar-threadlog-signing`/`instar-outbox-signing`) — no verbatim cross-store transplant validates.
31. **Rotation prior-key residual owned:** current+prior-key verify needs prior-`authToken` retention (a named precondition, unbuilt); absent it, an `authToken` rotation briefly narrows post-epoch eligibility to bridge+forced-mint (operator-visible, safe-direction), never a silent fleet wedge.
18. **`hasCanonicalReplyFor` backed by an in-memory `(threadId,inReplyTo)→bool` index** (LRU, live-segment rebuild) — no whole-file outbox scan on the hot path.
19. **Claim hardenings:** durable indexed consult at claim; release on `close`; LRU bound.
20. **store-unreadable only on no-hit:** an unreadable arm never refuses when the other arm has an eligible hit.
21. **Ship live, no new dark flag; rollback = revert PR.** A correctness repair of an always-on broken path ("A Dark Feature Guards Nothing"). Leg D's re-send half rides the sentinel's existing `enabled:false`; no Leg-C-only flag (A3 coupling). Rollback-safe: inbox rows verify under the unchanged HKDF key; the log-HMAC + `keyedFromSeq` are additive + off-chain (no downgrade quarantine); `wireCreatedAt`/`ingress` are additive fields a reverted reader ignores.
22. **One emergency valve, normalization-ONLY, safe-direction:** `threadline.identityNormalization.emergencyDisable` reverts Leg C's alias→fp NORMALIZATION step only; the universal participant check (FD10) and c2 post-check are NEVER valve-revertible (so it can re-open phantom mints, never a hijack). Live-read, audited, surfaced on `/guards` + `machineCoherenceManifest`.
23. **Refusal typing + self-correcting transition string;** refusal strings never interpolate ids/fps/paths.
24. **Config-migration parity:** neither new knob (`emergencyDisable`, the sweep clamp) needs a `migrateConfig()` entry (default-absent → safe behavior); the sweep clamp is a load-time clamp, downgrade-safe.

## Open questions

*(none — all resolved into Frontloaded Decisions above)*

## Observability & self-detection

- **Coherence audit:** the declared agreement invariant joins the cadenced coherence-audit walk — a BOUNDED sample (N per tick) of post-epoch inbounds checked present-in-both; drift raises ONE deduped attention item. Restores the alarm the union read removes.
- **Wedge counter:** N consecutive `absent-from-union` refusals on one thread within a window → one deduped signal. Counter map LRU/TTL-bounded.
- **Identity counter:** repeated isolations of the SAME resolved, trust-anchored fingerprint → one deduped signal. Map LRU/TTL-bounded.
- **Degraded-read + suppression audit:** every `store-unreadable` and every digest-backstop suppression writes a scrubbed metadata row.
- **Local verification surface:** an IN-MEMORY per-branch validator outcome counter (inbox-hit / log-union-fallback-hit / refusal-by-type) served on a route — NOT a per-send JSONL append. A non-zero union-fallback rate on POST-epoch inbounds is a direct Leg A drift detector. Plus `GET /threadline/threads/:id/health` and the ABSENCE of the anti-hijack log signature for a trust-anchored peer.
All signal-only; none gates delivery.

## Regression set (every item live-observed or reviewer-derived)

Tiers: U = unit, I = integration (HTTP pipeline), E = e2e. The live two-agent retest (CMT-1981) is the L7 live-proof artifact.

1. (I) Local-delivered inbound → pointered reply accepted on both branches; inbox row present, `ingress: local-token`, resolved-fp-or-null.
2. (I) Zero-inbound-row thread → pointerless-with-threadId accepted.
3. (I) NON-latest eligible union member as pointer → accepted (membership, not latest).
4. (I) **The wedge case:** warm-bound; latest inbox slot claimed by an earlier 2xx sibling; new inbound log-resident/inbox-absent → pointered reply ACCEPTED. Headline test.
5. (U) Leg A′ resolution: threadId-less inbound gets ONE id used for BOTH persistence and routing (no synthetic-vs-minted divergence); `handleInboundMessage` consumes the carried verdict, never recomputes (TOCTOU: resume-map mutated between accept and async router → no split).
6. (U) Guard fires on ALL branches: trusted-tier sender + foreign presented threadId via the warm-LISTENER branch → isolated (not just cold-spawn); pipe-spawn branch likewise.
7. (U) Cold-box: hostile presented threadId with an EMPTY resume map but a persisted ThreadLog → existence detected, owner-IDENTITY NOT authoritatively resolvable (no ConversationStore record) → ISOLATED (never "sender fp is in participants()"); rows land on the isolation thread; victim thread's union + `latest` unchanged. Companion: a foreign pre-fix row already in the victim's log (its fp in participants()) is NOT reply-eligible, because eligibility matches the AUTHORITATIVE owner, not the log-derived set (round-3 N1).
8. (U) Anti-hijack matrix — every row incl. verified-and-foreign ⇒ isolate; tier-3-flip either side ⇒ isolate; owner-alias-via-registry-only ⇒ isolate; genuine first-contact (no owner) ⇒ spawn; alias→multi-fp ⇒ isolate; same trust-anchored peer, alias-recorded binding + raw-fp inbound ⇒ no isolation, no phantom.
9. (U) Dedup: same id + original bytes (incl. wireCreatedAt) → `duplicate`, never `collision`; no spawn (ingest short-circuits); one `redelivery` audit row. Non-owner collision under a chosen id → discarded, honest owner write lands (honest-first NOT required). Id-mutated legacy re-mint w/ redelivery marker → body backstop within scope/window/floor; unmarked → not backstopped; identical ≥200-char body twice from same sender w/o marker → NOT suppressed; different sender / outside window / <200 char → NOT suppressed.
10. (U) Eligibility: `backfilled:true` never reply-eligible; post-`keyedFromSeq` entry w/o valid HMAC never eligible; entry whose `peerFingerprint` is not a thread participant never eligible; pre-`keyedFromSeq` unkeyed entry eligible (bridge).
11. (U) Ack-class: excluded from emptiness test (ack-only thread → pointerless accepted); never in resend queue; never acked back; condition-driven tracker purge runs every boot-sweep (idempotent across a fixed→unfixed→fixed bounce).
12. (I) Restart mid-reply: in-memory claims lost, durable indexed `hasCanonicalReplyFor` still refuses a second reply; aborted connection releases the claim on `close`.
13. (U) Typed refusals: absent-from-union vs store-unreadable distinguishable; absent carries the self-correcting remedy; store-unreadable NEVER refuses when the other arm has an eligible hit; no id/fp/path interpolation; degraded reads audited.
14. (U) Chain break mid-log → quarantine-and-continue; membership before the break unaffected.
15. (I) Mixed-fleet legacy shapes against a FIXED box: stale-id pointer (accepted), pointerless-on-canonical with non-ack rows (typed 400 + remedy), forced-mint RECONCILE header (ordinary new thread), id-mutated drain re-mint (item 9).
16. (U) Wiring-integrity: enumerate inbound-persisting routes; assert each rides the funnel (both stores, routedThreadId, provenance); zero-direct-callers ratchet for the append primitives.
17. (U) Parity ratchet over the UNION read: post-epoch inbound present in both stores on healthy turns.
18. (U) Growth bounds: inbox AND outbox time-floored rotation (never evict < max(TTL, horizon)); membership reads never whole-file-scan (probe order + index asserted); `hasCanonicalReplyFor` uses the index; eligibility path never whole-file-scans (cached flags).
19. (U) Rotation invariants: prefix-only eviction, atomic rewrite, `readNewestJsonlMatch`/`readLatestCanonicalInboxForThread` correct after rotation; null-tolerant latest consumers.
20. (U) Key rotation: an `authToken` rotation with `keyEpoch` current+prior → post-epoch history stays eligible (no fleet wedge).
21. (U) Emergency valve: `emergencyDisable:true` reverts normalization only; verified-and-foreign STILL isolates; participant check STILL runs; flag surfaces on `/guards`.
22. (U) Rollback: log-HMAC + keyedFromSeq off-chain (a downgraded reader does not quarantine); inbox rows verify under unchanged key; `wireCreatedAt`/`ingress` ignored by reverted reader.
23. Forensics hygiene (A4): all store assertions parse the id FIELD; no positive substring greps.
24. (E) Feature-alive: co-located two-agent exchange (send → spawn → pointered reply → ack) completes on the production init path.
25. (U) Owner-authoritative eligibility: a log-resident row whose fp is in `participants()` but is NOT the authoritative owner → ineligible; a row whose fp IS the authoritative owner → eligible; owner-match resolves live via ConversationStore (cache hit ⇒ O(1)); existence-without-authoritative-owner ⇒ isolate.
26. (I/U) Two-store write atomicity: a simulated crash between the log and inbox appends leaves an intent marker; the boot sweep completes the missing side from the survivor; no accepted-but-unstored inbound.
27. (U) Concurrent first-contact: two simultaneous threadId-less arrivals from the same peer resolve to ONE threadId (affinity reuse on the second), never two sibling mints.
28. (U) dedup key: attacker row + owner row under the same chosen messageId (different fp) → two distinct chained rows, no collision; the honest owner row wins at read via owner-match (honest-first NOT required).
29. (U) store-unreadable typing: an injected fs-error on the eligibility read types as `store-unreadable` (not `absent-from-union`); the inbox arm's null-on-error carries the same typing.
30. (U) HMAC domain separation: an outbox row copied verbatim into the inbox does NOT validate (distinct `instar-outbox-signing` vs `instar-inbox-signing`); likewise inbox↔log.
31. (U) Rotation residual: an unfixed-box rotation drops `keyedFromSeq` → on re-upgrade the thread reverts to bridge semantics (safe); `authToken` rotation without prior-key retention narrows post-epoch eligibility to bridge+forced-mint, never wedges.

## Rollout / rollback

- Single PR, all legs (A′/A/B/C/D). One-PR justification (contested by round-1 external review, resolved): B+C hard-coupled (A3); A is the WRITE side of B's invariant; A′ is the shared seat all of A/B/C depend on; D's ingest half is the fixed box's defense against unfixed peers during the skew. The build may stage legs as reviewable commits within the one PR.
- Ships LIVE (FD21). Rollback = revert PR; rollback-safety pinned in FD21 (off-chain HMAC, additive fields, unchanged key derivation).
- **Transition honesty:** the union WIDENS pointered acceptance; the pointer-required rule NARROWS pointerless acceptance on threads whose union has non-ack rows (incl. the pointerless-on-canonical convention both agents run today). Mitigations: the self-correcting refusal string (one round trip), convention retirement announced AT release via the CMT-1981 ship ping. Unfixed peers' legacy shapes enumerated in regression 15.
- Post-merge protocol (registered commitments): deliver CMT-1976/1979/1980 with the merged PR; CMT-1981 ship ping on ebf68943 → sagemind retests plain inReplyTo against a fresh co-located inbound (+ the warm-wedge case if arrangeable) → both sides retire the workaround convention.
- Known vestige until this ships: pings from Echo phantom-mint on sagemind's box (pre-registered — vestige, not regression).

## Explicitly out of scope

- `messages/index/inbox.jsonl` (different subsystem; A4).
- The forced-mint reconciliation-header convention (dies when this ships).
- Retroactive inbox backfill (FD5).
- Full store-model collapse to a single event log (Alternatives Considered — a possible future refactor, not this fix).
- Rider promise: ISO-timestamp the lifeline stderr writer — registered for delivery alongside CMT-1976's brief at build time (Close the Loop; the build PR checklist carries it).
