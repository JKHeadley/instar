---
title: "Threadline Canonical, Symmetric History + Conversation Discipline (Robustness Phase 2)"
slug: "threadline-canonical-history"
author: "echo"
eli16-overview: "threadline-canonical-history.eli16.md"
tracking: "CMT-1362"
program: "Threadline Robustness (problem statement .instar/plans/threadline-robustness-problem-statement.md, F1–F6)"
parent-principle: "Structure beats Willpower"
lessons-engaged:
  - "docs/signal-vs-authority.md — Phase 2 adds NO new blocking gate; the canonical log is audit/observability and the conversation-discipline resolver is recoverable routing, never an authority over an irreversible action. The cross-end divergence signal is advisory-only and never auto-loops a backfill or blocks a send."
  - "Phase-2-anti-pattern — this IS a 'Phase 2' spec, so the deferral discipline is applied to ITSELF: every surface deferred to Phase 3 (F2 logical identity) is named with a concrete non-blocking seam, and the symmetry arm is fenced honestly against a peer-identity asymmetry the foundation actually has (R3 'same bytes' is delivered over PROVABLY-shared bytes only)."
  - "Cross-Machine Coherence — the canonical thread log is per-machine BY DESIGN under the existing single-holder model; every state surface (log, head-cache, symmetry digest, resolver binding, divergence Attention item, read routes) declares its multi-machine posture; the resolver JOIN + append are holder-only so two machines never write sibling logs for one thread."
  - "Structure > Willpower — every message is appended to the one canonical log through a single funnel, enumerated by a wiring-integrity test; idempotency is a persisted seen-set (not a best-effort tail scan); no session has to 'remember' to log, and there is exactly one read source."
  - "guard-bypass-carries-its-own-cap — the read-source swap is a UNION (canonical log ∪ bounded best-effort backfill) so post-upgrade history can only gain, never regress; the backfill is bounded + logged; a persistently-failing append is LOUD (a deduped Attention item), matching Phase 1's fail-open bar, not a silent JSONL line."
  - "Bounded Notification Surface — divergence and append-failure both raise at most ONE deduped, aggregated Attention item per (thread, episode), never per message; a peer oscillating its claimed digest collapses to one episode."
approved: true
approved-by: "Justin (operator, telegram topic 12476)"
approved-at: "2026-06-12T22:00:00-07:00"
review-convergence: "2026-06-13T04:55:34.690Z"
review-iterations: 4
review-completed-at: "2026-06-13T04:55:34.690Z"
review-report: "docs/specs/reports/threadline-canonical-history-convergence.md"
cross-model-review: "gemini-cli:gemini-2.5-pro"
single-run-completable: true
frontloaded-decisions: 12
cheap-to-change-tags: 0
contested-then-cleared: 1
---

# Threadline Canonical, Symmetric History + Conversation Discipline (Robustness Phase 2)

## Problem statement

On the evening of 2026-06-11, two agents (Echo and Dawn) ran an extended agent-to-agent
negotiation that neither fleet could later audit coherently. Two distinct, evidenced failures in
how Threadline records and groups conversations made the negotiation un-auditable and fragmented:

- **F3 — History is not canonical or symmetric.** `threadline_history(msg-1781236493501-ingw5t)`
  returned `messageCount: 0` **on the sending agent's own machine**, while that machine's local
  outbox held ≥4 messages on that very thread. The two ends of one conversation hold *different*
  logs; an agent cannot reliably audit even **what it itself said**. Because the reply-counts-as-ack
  mechanism (Phase 1, G3) keys on a thread's message record, an un-auditable per-thread history also
  makes that ack signal untrustworthy.
- **F5 — Thread proliferation, no canonical conversation.** One workstream (the feedback cutover)
  with **one** peer spanned ≥8 open threads in a single evening (`msg-1781204881880`,
  `msg-1781209184165`, `thread-1781209184165-hcqn71`, `msg-1781236493501`,
  `thread-1781236493501-cxdkqo`, `thread-5de94921`, `thread-daebf6ae`, `thread-840d5c1d`). Each new
  inbound reply tended to mint or fork a thread; context fragmented; there was no single place either
  agent could read "the negotiation."

This spec is **Phase 2** of the Threadline Robustness program. It satisfies two requirements:

- **R3 — Canonical, symmetric, auditable history.** One **append-only, hash-chained log per thread**;
  `threadline_history` reads **that**, never a lossy derived view; an agent can always audit its own
  sent messages per-thread; and the two ends' message records are **content-addressed over
  provably-shared bytes** so divergence is a loud, structural signal rather than silent drift.
- **R6 — Conversation discipline.** Default to **one canonical thread per (peer, workstream)**;
  replies join it rather than forking; forks require **explicit intent**.

Phase 2 builds directly on the durable per-conversation store Phase 1 extended (the
`ConversationStore`'s CAS-protected per-thread record), and reuses the **exact** hash-chain pattern
already shipped in-tree for audit logs (`MandateAudit`, `TrustAuditLog`:
`hash = sha256(prevHash + canonicalEntry)`, append-only JSONL, `verify() → {ok, brokenAt}`).

### The honest scope of "symmetric / both ends fetch the same bytes"

R3's ideal phrasing is "one append-only log per thread, both ends fetch the **same bytes**." Two facts
of the foundation bound what that can mean in Phase 2:

1. **A single globally-shared chain** that two independent agents both append to is a
   distributed-consensus problem (two writers, one ordered log) — it would require a shared store or a
   lockstep protocol, **violating no-flag-day** (Dawn updates independently; the relay is stateless
   pass-through; `conversations.json` is per-machine).
2. **The two ends do NOT hold a byte-identical view of peer IDENTITY.** Phase 1 had to make
   reply-counts-as-ack key on `threadId` *precisely because* name↔fingerprint resolution is asymmetric
   across ends (Phase 1 grounding §5). Any cross-end digest that hashes an identity string would
   therefore report **false `diverged` on healthy threads** — turning the loud signal into noise.

Phase 2 delivers "same bytes" at the granularity that matters for auditing *what was said*, over
**provably-shared bytes only**, and is honest about the rest:

1. **Each end keeps its own canonical, locally hash-chained per-thread log** — the structural F3 fix.
   Needs **zero** peer cooperation; flag-day-free by construction. It alone closes the literal incident
   (a sender reading 0 of its own messages).
2. **Per-message records are content-addressed over a projection that EXCLUDES identity** — only fields
   the two ends provably hold byte-identically (the message's own id, body text, and the sender-stamped
   `createdAt`, all carried verbatim in the envelope; see FD-5 and the cross-boundary grounding it
   mandates). So the *message records themselves* are byte-identical on both ends.
3. **Whole-thread symmetry is cross-VERIFIABLE** via an **order-independent, incrementally-maintained**
   set accumulator over the per-message digests, exchanged as an additive wire field; divergence is
   detected and surfaced **loudly** but **advisory-only**, and a bounded, participant-authorized,
   terminating backfill lets two upgraded peers actually converge. Against an un-upgraded peer this
   degrades to "symmetry unverified (peer legacy)" — never a flag-day, never a broken conversation,
   never a false `diverged`.

This is the same honesty posture Phase 1 used for its single-holder caveat: the ideal is named, the
achievable guarantee is delivered over provably-shared bytes, and the residual (a single shared chain;
cross-end identity symmetry) is explicitly weighed and deferred (see *Alternatives considered* and the
Phase-3 seam), not silently dropped.

### What this spec is NOT

- **One-logical-identity-per-agent across machines/fingerprints (F2)** — that is **Phase 3** (R4).
  Phase 2's canonical log is **per-machine by design** under the existing single-holder model. Phase 2
  records the per-entry authoring identity (`author`) and uses identity-free content digests so Phase 3
  can **merge** an agent's per-machine logs without rework; it does not build that merge, and it does
  not attempt cross-end peer-identity symmetry (the explicit residual above).
- **A new commitment/binding protocol.** Binding still lives only in the existing operator-anchored
  Coordination Mandate / ReviewExchange flow (Phase 1, G2). Phase 2 grants prose no new authority.
- **A single globally-shared per-thread chain** (see "honest scope") — explicitly weighed and deferred.
- **Re-litigating Phase 1.** The negotiator lease, prose-inertness, and honest-ack wiring on `main` are
  untouched. Phase 2 is additive to them.

## Grounding in current code (what exists today)

Verified on `echo/threadline-canonical-history` (off `JKHeadley/main` @ v1.3.508, Phase 1 merged):

1. **`threadline_history` reads a derived, per-machine aggregate — the F3 surface.** The MCP tool
   (`src/threadline/ThreadlineMCPServer.ts:753–821`) calls `deps.getThreadHistory()`, wired via
   `getThreadHistoryViaHttp` (`src/threadline/mcp-http-client.ts:143–160`) to the agent server's
   `GET /messages/thread/:threadId` (`src/server/routes.ts:18553–18573`) → `messageRouter.getThread()`.
   `getThread` (`src/messaging/MessageRouter.ts:324–346`) reads a **derived `threads/{threadId}.json`
   aggregate** (`MessageThread { messageIds[], lastMessageAt, status }`, under
   `{stateDir}/messages/threads/`, `src/messaging/MessageStore.ts:14, 34, 299–333`) and hydrates each
   `messageId` from the per-message envelope store. **Two structural defects make it lossy:**
   - The aggregate is built **opportunistically and non-fatally** by `updateThread`, called from
     `relay()` (inbound, `MessageRouter.ts:272–278`) and `recordLocalOutbound` (outbound local
     fast-path, `:289–304`), each in a `try/catch` that only `console.warn`s on failure (comments at
     `:267–271`, `:282–287` document the historical "C/D bug": relayed threads never aggregated, and
     "each node's history held only the other agent's half"). A failed/skipped `updateThread`
     **silently drops a leg** — exactly the `messageCount: 0` symptom.
   - A **placeholder** `GET /threadline/messages/thread/:id`
     (`src/threadline/ThreadlineEndpoints.ts:474–484`) returns `{ messages: [], messageCount: 0 }`
     unconditionally. Not the path the MCP tool reads today, but a second hard-zero source enumerated so
     the build removes the dead code path, not just re-points the read (D-C).
   - `GET /messages/thread/:threadId` guards `threadId` with `MSG_ID_RE = /^[a-f0-9-]{36}$/`
     (`routes.ts:18221, 18560`) — UUID-only, so a `msg-…`/`thread-…` id 400s. The new read routes must
     accept the real minted shapes via a tight anchored allowlist (FD-7), NOT a loose prefix match.

2. **The sender already has its own sent messages durably — just not where history reads.** Every
   outbound send appends to `{stateDir}/threadline/outbox.jsonl.active`
   (`ListenerSessionManager.appendCanonicalOutboxEntry`, `:210–247`; HMAC-signed JSONL; from the
   relay-send local + relay paths, `routes.ts:19537, 19672`). **The entry holds `{id, timestamp, from,
   senderName, trustLevel, threadId, text, to, recipientName, outcome, hmac}` — it has NO message
   `createdAt` distinct from the append `timestamp`, and NO `contentDigest`.** This is the backfill
   source for outbound legs (D-C) AND the reason backfilled legs cannot reconstruct the live digest
   (FD-5 marks them `backfilled`, excluded from symmetry).

3. **`ConversationStore`** (`src/threadline/ConversationStore.ts`) — durable per-thread record,
   per-machine `{stateDir}/threadline/conversations.json`, single-writer `mutate(threadId, fn)` with
   optimistic version CAS, FIFO per-threadId queue (depth 256), 8-retry CAS budget, atomic
   tmp-write+rename, whole-file rewrite of up to `MAX_ENTRIES=1000` records per write. Holds
   `messageCount`, `lastInboundHash`, `lastOutboundHash`, `subject`, `participants.peers[]`,
   `negotiatorLease` (Phase 1). **`prune()`/`pruneMapInPlace()` (`:671–726`) delete map keys with NO
   removal/eviction callback** — the only seam is the lifecycle `journalSeam` (started/bound/unbound/
   closed, `:448–480`), which does NOT fire on TTL/LRU eviction. So FD-10's "delete the log when its
   conversation is pruned" **requires a NEW eviction seam** (E1 below; named in the implementation
   surface). It is the home for the resolver binding + the head-cache fields — but the head-cache is
   written on a coalesced cadence, NOT a per-message CAS (FD-2, the per-message-CAS cost finding).

4. **Thread identity is minted ad hoc — the F5 surface.**
   - **Outbound** (`routes.ts:19272`): `const effectiveThreadId = threadId ?? randomUUID()` — a fresh
     UUID, no (peer, workstream) grouping.
   - **Inbound** (`ThreadlineRouter.handleInboundMessage`, ~`:525–572`): a missing `threadId` is filled
     from an **ephemeral, verified-only** peer-affinity hint (`ConversationStore.getAffinity`,
     in-memory, 10-min sliding / 2-hr absolute, **lost on restart**, `ConversationStore.ts:162–175,
     639–667`); a miss mints a fresh UUID. A code comment at `:162–167` warns that **promoting affinity
     to a durable binding "would reopen a hijack vector"** — the resolver (D-E) heeds this by keying on
     the VERIFIED fingerprint only and treating the subject slug as a local grouping hint, never an
     inbound routing authority.
   - **Inbound message id stability is NOT yet proven verbatim across ends** — the receiver reconstructs
     the envelope from `body.message` (`ThreadlineEndpoints.ts:~436–445`) and derives sender identity
     from the `x-threadline-agent` header (a NAME, asymmetric with a fingerprint). FD-5 mandates a
     cross-boundary grounding+test that `message.id` and `createdAt` travel verbatim; if id is NOT
     verbatim, the cross-end key falls back to `(threadId, contentDigest)` with the digest over
     `{body, createdAt}` only.

5. **Relay is stateless pass-through; persistence is end-to-end.** The relay routes directly to the
   peer's inbound endpoint (`RelayClient.sendAuto` → relay `MessageRouter.route`); it persists **no**
   message content. Dual path: local delivery (POST to a known peer's `/messages/relay-agent`,
   `routes.ts:18312+`) and relay fallback; both append to the canonical outbox. **A canonical per-thread
   log cannot live relay-side; it is replicated end-to-end** — exactly the design below.

6. **Inbound receive funnel (Phase 1 precedent to mirror).** Phase 1 added a single
   `recordInboundAck(ctx, msg)` funnel that every inbound-receive route calls, plus a wiring-integrity
   test enumerating the routes. Phase 2 reuses that exact pattern for the append funnel (D-B). Inbound
   lands at `POST /threadline/messages/receive` (`ThreadlineEndpoints.ts:379–470`) and the
   `/messages/relay-agent` local fast-path — both are append sites.

7. **Hash-chain + append-only-JSONL precedents in-tree (reuse, do not reinvent):**
   `src/coordination/MandateAudit.ts` (`prevHash`, `hash = sha256(prevHash + canonicalAuditEntry)`,
   `appendFileSync`, `verify()→{ok,brokenAt}`, `headHash()`) and `src/threadline/TrustAuditLog.ts`
   (same pattern at `{stateDir}/threadline/trust-audit-chain.jsonl`).

8. **Backup manifest does NOT include `threadline/` today.** `src/core/BackupManager.ts`
   `DEFAULT_CONFIG.includeFiles` = `['AGENT.md','USER.md','MEMORY.md','jobs.json','users.json',
   'relationships/','shared-state.jsonl*']`; `PostUpdateMigrator` unions only the PR-gate / topic-profile
   entries. So FD-9's backup inclusion is a **net-new additive migration**, not a "verify alongside
   existing" (E2). The dashboard Threadline tab reads `/threadline/observability/*` routes — so the
   canonical data must be surfaced there or it is invisible to the human (E6).

## Proposed design

Six changes, all **local to each agent** (no required peer change for the F3/F5 fixes → no flag-day):

### D-A. The Canonical Thread Log (delivers R3's "one append-only hash-chained log per thread")

A new **append-only, hash-chained log, one file per thread**, at
`{stateDir}/threadline/threads/{threadId}.log.jsonl`, implemented as a `ThreadLog` class that **reuses
the `MandateAudit`/`TrustAuditLog` pattern verbatim** (no new crypto, no new format):

```
ThreadLogEntry = {
  seq: number;                 // monotonic per-thread, 0-based — also the pagination cursor
  threadId: string;
  messageId: string;
  direction: 'outbound' | 'inbound';
  digestVersion: number;       // version of the canonical projection used for contentDigest
  contentDigest: string;       // sha256 over the identity-FREE canonical projection (FD-5) — ALWAYS
                               // computed LOCALLY by this end; a wire-supplied digest is a cross-check
                               // only and NEVER overwrites the locally-computed value
  backfilled?: true;           // reconstructed from outbox/aggregate; EXCLUDED from the symmetry head
  author: {                    // who authored THIS leg (Phase-3 merge seam — recorded, not yet trusted
    agentFingerprint?: string; sessionName?: string; machineId?: string;   // cross-agent)
  };
  peerFingerprint?: string;    // the verified peer on the other end of this leg (participant key)
  subject?: string;            // snapshot at append (display only)
  textRef: { kind: 'inline'; text: string } | { kind: 'store'; messageStoreId: string };
  at: string;                  // ISO append time
  prevHash: string;
  hash: string;                // sha256(prevHash + canonical(entry-without-hash))
}
```

- **Append is idempotent on `(threadId, messageId, direction)`, backed by a PERSISTED per-thread
  seen-set** (not a best-effort tail scan — FD-2). First-write-wins. A second append on an existing key
  whose `contentDigest` **differs** is a content collision: it is NOT overwritten and NOT silently
  dropped — it records a `collision` marker (a counter on the conversation + one observability line),
  because a same-id-different-content replay is a poisoning/tamper signal (FD-2).
- **`verify(threadId) → { ok, brokenAt? }`** walks the **live segment** of the chain like
  `MandateAudit.verify`, anchored at the first live entry as the documented chain root (archived prefix
  is not walked — FD-10). It detects a torn/edited line but **not a wholesale rewrite** (a self-consistent
  re-chain from seq 0). The partial anti-rewrite anchor is the **count + head hash stamped on the
  `ConversationStore` record**: a full rewrite that doesn't also forge the independently-stored stamp is
  caught by stamp↔log mismatch — but since the stamp is itself a coalesced log-wins cache, this defeats an
  **accidental/partial** tear, **not** a deliberate local-FS attacker who rewrites both the log AND the
  stamp (that attacker is already game-over and out of scope per Phase-1's FS-attacker posture). Named
  honestly. **Recovery playbook (operator):** a `local-integrity-fault` (a hash chain cannot be
  repaired) is resolved by deleting the corrupted `threads/{id}.log.jsonl` and re-converging from the
  peer via the bounded backfill — surfaced on `GET /threadline/threads/:id/health` with that guidance.
- **Head-cache, written on a COALESCED cadence — NOT a per-message CAS** (FD-2, addressing the
  whole-file-rewrite-per-message cost). The JSONL append (O(1) `appendFileSync`) is the **source of
  truth**. The `ConversationStore` record carries `historyCount?`, `historyHeadHash?`, and the symmetry
  accumulator `historySetAccum?` as a **best-effort cache**, refreshed opportunistically (debounced /
  on the next lifecycle mutate / lazily on read via `ThreadLog.head()`), never inside a synchronous
  per-message `mutate()`. **On any read or symmetry computation, if the cached head ≠ the log's actual
  head, the cache is REBUILT from the log (log wins) before use** — so a crash between append and stamp,
  or a torn write, can never advertise a head the log can't produce (FD-2).
- **Backward-compatible + machine-local by design.** No file = empty history (not an error). Per-machine
  under the single-holder model (one authoritative writer per thread per machine); cross-machine
  unification is Phase 3 (the `author` field is the recorded seam).

### D-B. The single append funnel (the structural F3 fix; Structure > Willpower)

Every message that touches a thread — **outbound send AND inbound receive, every path** — appends to the
canonical log through **one funnel** `recordThreadMessage(ctx, { threadId, messageId, direction,
envelope, author, peerFingerprint })`:

- Called from the outbound relay-send local + relay paths (beside `appendCanonicalOutboxEntry`) and from
  every inbound-receive site (`POST /threadline/messages/receive` and `/messages/relay-agent`),
  mirroring Phase 1's `recordInboundAck` funnel.
- **A wiring-integrity test enumerates every message-persisting route and asserts each goes through
  `recordThreadMessage`** — a future bypassing path fails the test. This is the structural guarantee
  that no leg is silently dropped again (root of F3).
- **The append never blocks delivery** (observability must not gate the message — Signal vs. Authority),
  and it is **off the send critical path**. But a failure is **LOUD, matching Phase 1's fail-open bar,
  not the old silent `console.warn`**: N consecutive append failures (or a failure-rate threshold) on a
  thread raises **ONE deduped Attention item** (reusing the FD-6 aggregation so Bounded Notification
  Surface holds) — because a persistently-incomplete history is the literal F3 symptom and must be
  operator-visible, not log-file-visible (FD-1). Idempotency (D-A) heals a transient miss on retry.

### D-C. `threadline_history` reads the canonical log — UNION with bounded, memoized backfill (delivers R3's read-source guarantee)

- `getThreadHistory` (and the `/messages/thread/:threadId` read it rides) is **re-pointed at the
  canonical log** (D-A) as the authoritative source, replacing the lossy derived aggregate. **The
  placeholder `GET /threadline/messages/thread/:id`'s hard `messageCount:0` code path is DELETED**, not
  left reachable (grounding §1).
- **The read is a UNION, so history can only gain, never regress** (`guard-bypass-carries-its-own-cap`):
  `canonical log ∪ bounded best-effort backfill`. On first read of a thread whose canonical log predates
  the upgrade, a **one-time, MEMOIZED, bounded** backfill (a `backfilled` marker on the conversation
  prevents re-scan) reconstructs entries through the idempotent funnel:
  - **Outbound legs** from a **tail-bounded** scan of `outbox.jsonl.active` (a cap on lines scanned —
    NOT the whole shared file; legs older than the window are not backfilled and the symmetry surface
    flags the gap — FD-config `backfillOutboxTailLines`).
  - **Inbound legs** from the **per-thread derived `threads/{id}.json` aggregate** (O(thread)) — **never
    `readAllEnvelopes()`** (a full-store scan). Inbound legs absent from BOTH the aggregate and the
    envelope store are **unrecoverable** — stated honestly; backfill recovers only what the aggregate
    already had, and the symmetry surface (not backfill) is what makes a residual gap visible.
  - **All backfilled entries are marked `backfilled:true` and EXCLUDED from the symmetry accumulator**
    (FD-5) — because the outbox lacks the message's `createdAt`/`contentDigest`, a backfilled leg cannot
    reproduce the live projection and would otherwise manufacture a false `diverged`. While any
    backfilled leg is present, symmetry reports `unverified`, never `diverged`.
- A new read route **`GET /threadline/threads/:id`** (bearer-gated, paginated by `seq` cursor,
  own-data-only) serves the canonical log; **id validation is a TIGHT anchored allowlist** for the real
  minted shapes (FD-7), with a `path.resolve` confinement check that the resolved log path is inside
  `{stateDir}/threadline/threads/` (defense-in-depth against traversal — F2). **Bodies returned are
  quoted UNTRUSTED peer-authored data, never instructions** — the route, the ELI16, and the Agent
  Awareness paragraph carry that note (mirrors the cartographer summary-is-data contract).

### D-D. Cross-end symmetry: identity-free digests + order-independent accumulator (delivers R3's "same bytes" + auditability)

- **Per-message content digest, recomputed on receive (B2/FD-5).** At send AND at receive, each end
  computes `contentDigest = sha256(canonical(messageCore))` over the **identity-FREE** projection
  (FD-5): the message's own id, body text, and the sender-stamped `createdAt` — fields both ends hold
  byte-identically. The wire MAY carry the sender's `contentDigest` + `digestVersion` as an additive
  field, but it is a **cross-check only**: the receiver's locally-recomputed digest is what enters the
  chain. A present-but-mismatched wire digest flags the entry (never overwrites it). A legacy peer that
  omits the field is unaffected — both ends still compute the same digest from the same projection.
- **Order-independent, O(1)-maintained thread accumulator (A1/A2/FD-5).** Symmetry compares
  `threadSync = { digestVersion, count, setAccum }` where `setAccum` is an **order-independent,
  incrementally-maintained** accumulator over the multiset `{ H_acc(contentDigest_i) }` of
  NON-backfilled entries, where `H_acc(x) = sha256("threadline-setaccum-v1\x00" + x)` — a
  domain-separated inner hash (the prefix label keeps the accumulator's input distinct from any other
  use of `contentDigest`; per the external review, the second hash is **domain separation, not
  redundancy**). The combiner is a **256-bit modular sum** (modulus 2²⁵⁶) — commutative, so two ends
  agree regardless of local arrival order; incremental, so it is O(1) per append, never O(n) per send.
  `count` accompanies it (equality requires BOTH); idempotency (D-A) guarantees no duplicate
  `contentDigest`s. **Honest strength bound (SA3):** `(count, setAccum)` equality is a reliable
  **consistency signal against a NON-adversarial peer** (the common case the loud signal exists for);
  it is **NOT a cryptographic proof of identical multisets against a *malicious* peer** — a modular sum
  is not collision-resistant, so a hostile verified peer could in principle craft a message set with a
  colliding `(count, setAccum)`. This is acceptable in Phase 2 *because symmetry is advisory-only* (it
  never blocks a send, never binds, never gates an irreversible action — Signal vs. Authority); a
  forged `verified` only misleads an auditor, it grants nothing. A collision-resistant incremental
  multiset commitment (e.g. an LtHash-style construction) is named as **Phase-3 hardening** (Alternatives),
  not built here. `setAccum` rides in the cached head fields; a cache/log mismatch rebuilds from the log
  first (D-A). `threadSync` piggybacks on normal outbound messages.
- **Honoring a peer's `threadSync` — verified-IDENTITY-derived, participant-scoped, monotonic
  (B3/SA1).** The **requesting/asserting principal is the fingerprint DERIVED from the Ed25519 identity
  public key that `threadlineAuth` verified the request signature against** (`fingerprint =
  derive(identityPub)`) — **never** the `x-threadline-agent` name header and **never** any body/envelope
  `from` field (grounding §4: the auth layer authenticates by name→pubkey lookup, so the fingerprint
  MUST come from the verified pubkey, not the asserted name). A peer's `threadSync` is honored ONLY when
  that derived fingerprint is a recorded **participant** (`participants.peers[]`, compared in the same
  canonical fingerprint encoding written at append; a representation mismatch fails CLOSED, never a
  loosened match) of the thread, and only if its `count` ≥ the last-seen peer count (a monotonic guard
  against a stale/replayed report regressing the view — the Phase-1 epoch lesson). A `threadSync` for a
  non-participant thread is dropped, never surfaced.
- **Symmetry states (closed set, advisory-only) — `GET /threadline/threads/:id/health`:** `verified`
  (peer `count`+`setAccum` match, no backfilled legs present), `diverged` (a concrete mismatch this end
  can corroborate against its own log), `version-skew` (peer present but `digestVersion` unrecognized/
  mismatched — logged, NOT collapsed into the benign legacy bucket, closing the downgrade vector F4),
  `unverified-peer-legacy` (peer never sent `threadSync`), `unverified-backfill` (backfilled legs
  present), `local-integrity-fault` (local `verify()` failed — a broken local chain can never masquerade
  as `verified`), `unknown` (no peer report yet). **Only `diverged` is actionable**, and it is
  **advisory** — it NEVER blocks a send and NEVER auto-loops a backfill.
- **Bounded, participant-authorized, TERMINATING convergence backfill (B1/A5/SA2/SA4).** On `diverged`,
  an upgraded agent may **pull** only the specific `contentDigest`s it is missing via an additive,
  read-only request kind. **CRITICAL authorization:** the responder serves records **only** for threads
  where the **derived-verified-fingerprint requester** (same `derive(identityPub)` rule as `threadSync`,
  never a name/body claim) **is the recorded participant**, and only `contentDigest`s already in that
  thread's log — a request for a non-participant thread returns empty + is counted (this closes the
  cross-thread content-exfiltration hole; the integration test must specifically cover an *identity-claim
  spoof*: a verified peer A naming peer B's thread gets empty + a counted refusal). **Response ingestion
  is untrusted (SA4):** a backfill record is treated as raw message content, NOT a log entry — the
  requester **recomputes `contentDigest` locally** from the identity-free projection, assigns its OWN
  `seq`/`prevHash`/`hash` via the append funnel, stamps `backfilled:true` and the verified responder
  fingerprint as `author`/`peerFingerprint` ITSELF, and **ignores the peer's `seq`/`prevHash`/`hash`/
  `backfilled`/`author`**. A returned record whose recomputed digest is NOT among the `missingDigests`
  this side actually requested is **dropped + counted** (a responder cannot push unrequested content); a
  record at an unrecognized `digestVersion` is dropped as `version-skew`. The exchange is **single-flight
  per thread**, served from a **bounded synchronous read** of the canonical log bounded by the response
  cap (read-until-cap, never a full scan; NEVER a session spawn), **rate-limited + size-capped** with
  concrete config knobs (`backfillMaxDigestsPerRequest`, `backfillMaxRecordsPerResponse`,
  `backfillRequestsPerPeerPerMinute` — the rate limit gates *episode initiation*, not just in-episode
  requests). After **one** backfill round, if still diverged (e.g. one end holds a leg the other never
  received and never will), the thread transitions to a **STICKY terminal `diverged-unreconcilable`**
  state (SA2): it STOPS requesting and raises the one deduped Attention item, and **stays terminal —
  suppressing ALL further backfill rounds AND Attention items for that thread, even as new divergent legs
  arrive (each new leg is still LOGGED so F3 holds, but triggers no new episode)** — until an explicit
  local reset (operator ack / re-bind). This is what bounds a peer that streams new unreconcilable legs
  one message at a time (it can mint at most one episode per thread, not one per message). Divergence
  re-evaluation is suppressed while a backfill round is in flight.
- **No-flag-day degradation (named).** Every wire field here is additive + optional. A legacy peer
  ignores `contentDigest`/`threadSync`, never answers a backfill, and our side keeps a complete *local*
  canonical log (the F3 fix holds unconditionally) and marks symmetry `unverified-peer-legacy`. No
  history-completeness or safety property rests on the peer honoring any new field.

### D-E. Conversation discipline: the canonical-thread resolver (delivers R6 / closes F5)

A **durable, verified-only `(peerPrincipal, workstreamKey) → canonicalThreadId` binding** on the
`ConversationStore` record (inheriting CAS/atomic-write), promoting today's ephemeral affinity to a
durable grouping **without** weakening the anti-hijack property the code comment warns about (§4):

- **`peerPrincipal` = the VERIFIED peer fingerprint** (never a name/subject the peer asserts). A
  deliberate indirection: Phase 3 widens it to a fingerprint-set→one-principal mapping. The resolver
  groups **only within a single verified peer** — it **never** merges across different peers.
- **`workstreamKey`** defaults to a normalized slug of the conversation `subject` for that peer (reserved
  `default` for subject-less exchanges). FD-3 fixes derivation + collision handling.
- **Default-join on the OUTBOUND send path only.** When an outbound send carries no explicit `threadId`
  and a verified `(peerPrincipal, workstreamKey)` binding exists, the send **joins** the canonical
  thread instead of minting. **Inbound grouping still defers to `threadId` + the existing
  participant/anti-hijack guard — never to a bare subject slug** (so a verified-but-adversarial peer
  cannot steer an inbound message into a victim thread by crafting a colliding subject; the durable
  binding is consulted on inbound only behind `trust.kind === 'verified'` and never overrides the
  threadId the peer actually sent). FD-3.
- **Forks require explicit intent.** A new thread is minted only when (a) the caller sets an explicit
  `fork`/`newThread` flag on `threadline_send`, or (b) there is genuinely no binding for that
  `(peerPrincipal, workstreamKey)`. A transient resolver **lookup failure** (CAS contention) is
  distinguished from a genuine absence — a lookup failure observes/retries, it does NOT mint a fresh
  canonical (avoids an under-load F5 regression). The dry-run JSONL logs `minted: fork-requested` vs
  `minted: no-binding` vs `joined: existing-binding` separately so the join/fork (and over-merge) rate
  is measurable before enforce.
- **Holder-only (E5).** The resolver JOIN + the append run **only on the conversation's holder
  machine**. An outbound send initiated on a non-holder machine for a peer whose canonical thread is
  held elsewhere either proxies to the holder or mints/handles locally per the existing placement rules —
  it does **not** append to a local sibling log for a threadId another machine owns. (Under the
  single-holder model the holder is well-defined; this is stated so the build routes the append, not
  guesses.)
- **Recoverable, never an authority (Signal vs. Authority).** Grouping is a convenience signal. A wrong
  grouping is **recoverable on the local side** (explicit fork; re-bind), it **never blocks a send**, and
  it **never gates an irreversible action**. Honest caveat (F5): a mis-join that has **already gone on
  the wire** is corrected **going forward** by an explicit fork — it does not retroactively un-write the
  threadId on the peer's durable history. This one-way wire effect is exactly why the JOIN ships
  **dry-run-first** (FD-8): the telemetry must show join/fork correctness before any reroute reaches the
  wire. The resolver has **no blocking authority of any kind**; Phase 2 introduces **no new gate**.

### D-F. Rollout posture (Graduated Feature Rollout)

- **CORE, ungated (additive; no change to delivery or to which thread a send uses):** the canonical log
  + append funnel (D-A, D-B); the read-source UNION (D-C, history can only gain); the symmetry digest +
  health route + divergence DETECTION (D-D, observability only).
- **DRY-RUN-gated (the one behavior change over ordinary traffic):** the D-E resolver **JOIN routing**
  (it changes which `threadId` an outbound send uses — a one-way wire effect), behind
  `threadline.canonicalHistory.conversationDiscipline.enabled` (default **false**) +
  `…dryRun` (default **true** when enabled): under dry-run it logs the would-join/would-fork decision to
  `logs/threadline-canonical-history.jsonl` and still mints as today. With the resolver OFF, the F3 fix
  and the symmetry surface fully hold.
- **The convergence-backfill request kind (D-D)** ships behind the same enable flag (a new wire
  request); divergence detection-and-surfacing is core (read-only).

## Decision points touched

- **No new blocking gate, no new authority.** Phase 2 adds history (audit/observability) + a recoverable
  routing convenience. The only "decision" it makes is which threadId an outbound send is grouped under —
  recoverable locally, never blocks a send, never gates an irreversible action, and dry-run-first because
  the wire effect is one-way.
- **Read-source swap** for `threadline_history` — to the canonical log, as a UNION (gain-only); the
  placeholder hard-zero path is deleted.
- **Three additive wire fields** — `contentDigest`+`digestVersion`, `threadSync = {digestVersion, count,
  setAccum}`, and a read-only participant-authorized bounded backfill request kind. Shapes are frozen as
  published interfaces (FD-5/FD-12); legacy peers ignore them.
- **New optional `Conversation` fields** — `historyCount?`, `historyHeadHash?`, `historySetAccum?`, a
  `collision` counter, and the `(peerPrincipal, workstreamKey) → canonicalThreadId` binding. Additive.
- **New `ConversationStore` eviction seam** (E1) — fired from `pruneMapInPlace` so a pruned conversation
  deletes its log file (does not exist today).
- **New read-only routes** — `GET /threadline/threads/:id` + `/health`; pool posture proxied-on-read.
- **Dashboard surface** — the observability routes powering the Threadline tab are re-pointed at the
  canonical log so corrected history + symmetry are visible to the human (E6).

## Multi-machine posture (Cross-Machine Coherence — mandatory declaration)

- **Canonical thread log + append funnel (D-A/D-B):** **machine-local BY DESIGN** under the single-holder
  model. The per-entry `author` field is the Phase-3 merge seam. **Append + resolver JOIN are holder-only
  (E5)** so two machines never write sibling logs for one threadId.
- **Head-cache (`historyCount/headHash/setAccum`):** **machine-local; authoritative only at the holder.**
  A standby never serves its own (possibly stale) head — a `?scope=pool` read proxies to the holder, and
  the holder rebuilds the cache from the log on any mismatch before serving.
- **Symmetry digest (D-D):** content-addressed + identity-free → **machine-agnostic**, meaningful across
  the Phase-3 merge without rework.
- **Divergence Attention item (D-D/FD-6) + append-failure item (FD-1):** **raised only by the
  conversation's holder machine** (one-voice-gated by single-holder ownership), deduped per (thread,
  episode) — two machines never double-alert.
- **Read routes (D-C/D-D):** bearer-gated, own-agent-only, **proxied-on-read** for `?scope=pool`; the
  holder re-applies id-shape validation and serves only its own ConversationStore's conversations (the
  proxy adds reach, not authority). Default scope local.
- **Conversation-discipline binding (D-E):** lives on the per-machine `ConversationStore`, authoritative
  at the holder. **Topic-transfer reconciliation (E4):** a Telegram topic moving machines does NOT move
  its Threadline A2A conversation (the relay address is part of the holder's identity — the documented
  "when a topic moves machines, its conversation deliberately does NOT move" mesh behavior), so the
  per-thread log is never stranded by a topic transfer; if the single-holder invariant is ever violated
  (split-brain), Phase 1's runtime duplicate-holder alert is the signal and the two logs are an honest
  Phase-3 surface, not a Phase-2 detection.

## Frontloaded Decisions

1. **Append-failure is LOUD; canonical log format reuses `MandateAudit`/`TrustAuditLog` verbatim.**
   `hash = sha256(prevHash + canonical(entry-without-hash))`, append-only JSONL, `verify()→{ok,brokenAt}`.
   One file per thread. N-consecutive-failure (config `appendFailureAlertThreshold`, default 3) → ONE
   deduped Attention item via the FD-6 aggregation.

2. **Idempotency = a PERSISTED per-thread seen-set (not a tail scan); head-cache is coalesced, log-wins.**
   Key `(threadId, messageId, direction)`; first-write-wins; a differing `contentDigest` on an existing
   key records a `collision` (a **saturating** counter, so an endless same-id-different-content replay
   cannot write-amplify; never overwrites). The seen-set is bounded per thread (config
   `seenSetMaxPerThread`) and LRU across threads with a global ceiling (`seenSetMaxThreads`). The
   `ConversationStore` head fields (`historyCount/headHash/setAccum`) are a best-effort cache refreshed
   on a coalesced cadence — **never a synchronous per-message `mutate()`** (so a hot thread does not
   rewrite the whole `conversations.json` per message), debounce window `headCacheCoalesceMs` (default
   500), single-flight per thread. **A READ never causes a `conversations.json` write (SI1):** on a
   cache/log mismatch a read (incl. `GET …/health` and a `?scope=pool` proxied read) recomputes the head
   **in memory from the live log and serves it WITHOUT writing back** — the next scheduled coalesce or
   lifecycle `mutate()` persists it — so dashboard/pool polling can never reintroduce per-read CAS
   amplification. The in-memory rebuild scans only the **live** (post-rotation) log, never `archive/`
   (bounded by `maxEntriesPerThread`). Unit-test: a duplicate replayed AFTER `> seenSetMaxPerThread`
   intervening entries is still deduped (the seen-set, not a tail window, is the authority).

3. **`workstreamKey` derivation + collision handling.** Normalized slug of `subject` (lower-cased,
   whitespace/punct-collapsed, length-capped); subject-less → reserved `default`. The **first** thread for
   a verified `(peerFingerprint, workstreamKey)` becomes canonical; later **outbound** sends on that key
   join it. **Inbound NEVER joins via the subject slug** — inbound grouping uses the peer-sent `threadId`
   + the existing participant/anti-hijack guard, consulting the durable binding only behind
   `trust.kind==='verified'` and never overriding a sent threadId. Modes via
   `threadline.canonicalHistory.workstreamKeyMode` (`subject-slug` default / `peer-only` / `off`). A
   same-slug collision within one verified peer is a recoverable over-merge that dry-run telemetry must
   measure (logged distinctly) before enforce; an inbound subject can NEVER reroute into a victim thread
   (tested).

4. **Body storage = inline ≤ `inlineMaxBytes` (default 8 KB), else a `store` reference.** Keeps per-thread
   log files bounded while self-describing for the common case.

5. **`contentDigest` v1 projection is FROZEN, identity-FREE, byte-precise, and grounded by a real
   cross-boundary test.** Projection = canonical JSON of `{ threadId, messageId, body, createdAt }` —
   sorted keys, UTF-8, normalized (`\n`) line endings, body as the exact received UTF-8 bytes — with
   **NO sender fingerprint / name / trust field** (the asymmetry that would cause false `diverged`).
   `messageId` and `createdAt` are the sender-stamped values carried verbatim in the envelope; a
   build-time grounding+test MUST confirm both travel verbatim send→receive across the REAL relay path
   (not a same-process test). **If `messageId` is NOT verbatim, the cross-end key falls back to
   `(threadId, contentDigest)` with the projection over `{ body, createdAt }` only** — documented as the
   contingency, decided now, not a stop-and-ask. The receiver ALWAYS recomputes the digest locally; the
   wire digest is a cross-check. `digestVersion` rides per-entry AND on `threadSync`; an unrecognized
   version → `version-skew` (not silently benign). The v1 projection is a **published cross-agent
   interface** documented byte-precisely in the **"Wire encoding (normative)"** section below so an
   independent peer (Dawn) reproduces it identically — the build-time cross-boundary test asserts
   **Dawn-shaped bytes**, not just same-process equality. The accumulator is computed **per
   `digestVersion`** (mixed-version threads report `version-skew`/`unverified`, never a cross-version
   comparison).

### Wire encoding (normative — the frozen v1 cross-agent interface)

These bytes cross to an independently-implemented peer; they are FROZEN for `digestVersion: 1` (LD1):

- **`contentDigest` projection** = RFC 8785 (JSON Canonicalization Scheme) serialization of the object
  `{ "body": <string>, "createdAt": <string>, "messageId": <string>, "threadId": <string> }` (keys
  lexicographically sorted by JCS; `body` is the EXACT received UTF-8 string, emitted by JCS's
  minimal-escaping rules — NOT `\uXXXX`-escaped beyond what JSON requires; `createdAt` is the verbatim
  wire string, e.g. `new Date().toISOString()` millisecond-UTC, hashed AS RECEIVED and never re-parsed/
  re-serialized through a `Date`). `contentDigest = lowercase-hex( sha256( utf8(JCS) ) )`. (If FD-5's
  cross-boundary test shows `messageId` is not verbatim, the v1 projection drops `messageId` — the
  `{body, createdAt, threadId}` form — decided now.)
- **`setAccum`** = `lowercase-hex( ( Σ_i bigEndianUint256( H_acc(contentDigest_i) ) ) mod 2²⁵⁶ )`,
  zero-padded to exactly 64 hex chars, where `H_acc(x) = sha256( utf8("threadline-setaccum-v1") || 0x00
  || utf8(x) )` — the domain-separation separator is a single explicit **NUL byte (0x00)**, identical to
  D-D (NOT a space; pinned by the reference-vector test). `contentDigest_i` is the lowercase-hex string. Σ over NON-backfilled entries of the same `digestVersion`. Big-endian
  byte→integer conversion; modulus 2²⁵⁶.
- **`threadSync`** = `{ "digestVersion": 1, "count": <int — non-backfilled entries>, "setAccum":
  <64-hex> }`.
- **Backfill request** = `{ "kind": "thread-backfill-req", "threadId": <string>, "missingDigests":
  <string[] ≤ backfillMaxDigestsPerRequest> }`; **response** = `{ "kind": "thread-backfill-resp",
  "threadId": <string>, "records": <message-core[] ≤ backfillMaxRecordsPerResponse> }` where each record
  carries ONLY `{ messageId, body, createdAt, direction }` (the requester recomputes everything else —
  D-D/SA4). An un-upgraded peer ignores an unknown `kind`.

6. **Symmetry: detect-and-surface in core; converge-backfill gated, participant-authorized, terminating.**
   `setAccum` is an order-independent, O(1)-maintained 256-bit modular sum over the domain-separated
   `H_acc(contentDigest)` of non-backfilled entries (Wire encoding); equality requires `count` AND
   `setAccum`, and is a consistency signal against a **non-adversarial** peer — NOT a collision-resistant
   proof against a malicious one (advisory-only; LtHash-style hardening is Phase-3, see Alternatives).
   Divergence is advisory: it never blocks a send, raises at most ONE deduped Attention item per (thread,
   episode), and drives at most ONE backfill round before the **STICKY** terminal `diverged-unreconcilable`
   state (which suppresses all further backfill + Attention for that thread until an explicit local reset,
   so a peer streaming new unreconcilable legs cannot mint an episode per message). The backfill responder
   serves only derived-fingerprint-participant-scoped, already-logged records, from a bounded synchronous
   read (read-until-response-cap), rate/size-capped; the requester recomputes ingested records and ignores
   peer-supplied chain fields (SA4).

7. **Read routes: tight id allowlist + path confinement; pool proxied-on-read; seq-cursor pagination.**
   `GET /threadline/threads/:id` + `/health` are bearer-gated, own-agent-only, paginated by **`seq`
   cursor** (O(limit) per page, default 100), and validate `:id` against an **anchored allowlist regex**
   per minted shape (`^(?:[0-9a-f-]{36}|msg-[a-z0-9]+(?:-[a-z0-9]+)*|thread-[a-z0-9]+(?:-[a-z0-9]+)*)$`),
   THEN confirm the resolved log path is inside `{stateDir}/threadline/threads/` (traversal defense).
   `?scope=pool` proxies to the holder, which re-validates. Bodies are returned tagged as untrusted data.

8. **Default-off + dry-run-first for the resolver JOIN only.** The F3 fix, the read-source union, and the
   symmetry surface ship live in core (additive / gain-only / observability). The single behavior change —
   the resolver rerouting an outbound threadId, a one-way wire effect — is enable-flag + dry-run-first,
   enforced only after dry-run telemetry shows correct join/fork (and acceptable over-merge) rates.

9. **Migration Parity (every clause grounded against the real tree).** `migrateConfig()` adds
   `threadline.canonicalHistory.*` (existence-checked, safe off/dry-run defaults) + `ConfigDefaults.ts`;
   `migrateClaudeMd()` adds an awareness paragraph WITH a proactive trigger ("audit what I said to
   `<peer>`" / "is this conversation in sync?" → `GET /threadline/threads/:id` / `/health`); routes follow
   the standard path. **Backup is a NET-NEW additive migration (E2):** add `threadline/conversations.json`
   (the head-anchor) to `BackupManager.DEFAULT_CONFIG.includeFiles` AND a `migrateBackupManifest` union for
   existing agents; the **bulky per-thread `threads/*.log.jsonl` are EXCLUDED from backup by design**
   (large, reconstructable via backfill, and the symmetry surface flags any residual gap) — stated, not
   silent. **Honest consequence + restore correctness (SI2/D1):** a restore-from-backup has
   `conversations.json` (the head anchor) but EMPTY logs; inbound legs absent from both the outbox tail
   and the aggregate are **unrecoverable** by backfill (a restore can lose some auditable history — the
   symmetry surface flags it loudly rather than hiding it). Because the one-time `backfilled` memo lives
   on the conversation record (which the restore brings back), the read path **ignores a set memo when
   the log file is ABSENT** and re-runs backfill — otherwise a restored thread would stay permanently
   empty. New `Conversation` fields are additive+optional (older code ignores them on load → revert is
   clean both directions). On revert (flags off): the log keeps being written (it is the correct read
   source), the resolver stops rerouting, stale symmetry state is inert. No hook/skill changes.

10. **Retention decoupled from LRU eviction (SA5) + thread-dir cap + orphan sweep.** **A `Conversation`
    record evicted under MAX_ENTRIES/LRU map pressure is COLD, not CLOSED — its log is KEPT** (deleting it
    would destroy a live relationship's history and re-create an empty log on the next message, a fresh F3
    regression for exactly the high-traffic agents that overflow the map). Log deletion is driven ONLY by
    the **`closed` lifecycle transition** (via the existing `journalSeam`, which already fires on close),
    as a **post-commit** action (never mid-`mutate()`, so a CAS rollback can't strand a record without its
    log), routed through `SafeFsExecutor`; pinned conversations keep their logs. Independent of close, a
    per-file size cap (`maxEntriesPerThread`) rotates oldest entries to `threads/archive/` (with its OWN
    file-count cap) — **rotation NEVER mutates `setAccum`/`count`** (they are retention-independent running
    values, so asymmetric local rotation between two ends can never manufacture a false `diverged`; SI2),
    and `verify()` validates the **live segment** with the first live entry as the documented chain root
    (archived prefix is not walked). A **thread-dir LRU/age cap** bounds the directory even if pruning lags
    or the resolver is off, and an **orphan sweep** reclaims a `*.log.jsonl` with no matching `Conversation`
    record older than the TTL. All deletes via `SafeFsExecutor`.

11. **Symmetry health states are a closed set (FD-6):** `verified`, `diverged`, `diverged-unreconcilable`,
    `version-skew`, `unverified-peer-legacy`, `unverified-backfill`, `local-integrity-fault`, `unknown`.
    Only `diverged`/`diverged-unreconcilable` are actionable; both are advisory and drive the single
    aggregated Attention item (one-voice-gated to the holder).

12. **Wire-field shapes are FROZEN published interfaces, named byte-precisely.** `threadSync = {
    digestVersion:int, count:int, setAccum:hex-string }`. Backfill request = `{ kind:'thread-backfill-req',
    threadId, missingDigests:string[] (≤ backfillMaxDigestsPerRequest) }`; response = `{
    kind:'thread-backfill-resp', threadId, records: ThreadLogEntry-core[] (≤ backfillMaxRecordsPerResponse)
    }`. Carried in the existing envelope content field; an un-upgraded peer ignores an unknown `kind`. The
    backfill request/response are NOT tracked sends (they create no `A2ADeliveryTracker` awaiting-ack
    record — mirrors the Phase-1 holding-notice property), so they never pollute the G3 honest-ack signal.

## Alternatives considered

- **A single globally-shared per-thread chain (both ends append to one ordered log).** The most literal
  R3 "same bytes." Rejected for Phase 2: two independent writers on one ordered log is distributed
  consensus needing a shared store or lockstep — a **flag-day** with an independently-updating peer, over a
  **stateless** relay, with **per-machine** state. Phase 2's identity-free per-end digests + verifiable
  accumulator deliver byte-identical *message records* without it. A genuine durable-conversation-authority
  model (append-only event log / broker partition ownership) is weighed for a future iteration, not forced
  into Phase 2.
- **Relay-hosted canonical log.** Trivially shared, but the relay is **stateless pass-through by design**
  and making it stateful adds a large trust + availability dependency (the relay would hold conversation
  content). Rejected; end-to-end replication keeps the relay's zero-content-knowledge property.
- **Keep the derived `threads/{id}.json` aggregate, just fix its update paths.** Smaller diff, but the
  defect is structural: opportunistic, non-fatal, no tamper-evidence, no idempotency — and "patch the warn
  sites" is exactly how the C/D bug recurred. A real append-only log + one funnel + a wiring test is the
  structural fix.
- **A collision-resistant incremental multiset commitment (LtHash-style) for `setAccum`.** Stronger than
  the modular sum — it would make `verified` a cryptographic proof even against a *malicious* verified
  peer (closing SA3). Deferred to **Phase-3 hardening** rather than built here: the modular sum is
  order-independent + O(1)-incremental (the two properties Phase 2 needs) and symmetry is *advisory-only*,
  so a forged `verified` misleads an auditor but grants nothing — the cost/benefit favors shipping the
  simple combiner now and naming the upgrade path. The Wire-encoding section freezes the v1 combiner so a
  future `digestVersion: 2` can introduce LtHash without breaking v1 chains.
- **An order-DEPENDENT rolling-fold head digest (`r_k = sha256(r_{k-1}+cd_k)`).** Cheaper to describe, but
  the two ends append in different local orders (inbound/outbound interleave; relay vs local-fastpath
  race), so a fold would report permanent false `diverged` on healthy threads. The order-independent
  accumulator (FD-5/FD-6) is what makes the signal trustworthy.
- **Including sender identity in the content digest.** Rejected — name↔fingerprint is asymmetric across
  ends (Phase 1 grounding §5), so it would manufacture false `diverged`. The projection is identity-free.
- **Content-based thread grouping via an LLM/classifier.** Rejected on Signal-vs-Authority and
  reliability: a classifier deciding conversation identity is a brittle routing authority. The verified
  fingerprint + deterministic subject-slug is deterministic, recoverable, never an authority.
- **Make divergence detection BLOCK sends until re-converged.** Rejected: it would make an observability
  signal a blocking gate and could wedge a live conversation on a transient mismatch. Divergence is
  advisory; backfill is bounded and terminating.

## Implementation surface (files the build touches)

- **New** `src/threadline/ThreadLog.ts` — the per-thread append-only hash-chained log (D-A), modeled on
  `MandateAudit`/`TrustAuditLog`: `append(entry)` (idempotent via persisted seen-set; collision marker),
  `read(threadId,{limit,afterSeq})` (seq-cursor), `verify(threadId)`, `head(threadId)→{count,headHash,
  setAccum}` (with log-wins rebuild on cache mismatch), retention + `archive/` rotation (FD-10).
- **New** `src/threadline/recordThreadMessage.ts` — the single append funnel (D-B) + the
  `(peerPrincipal, workstreamKey)` resolver (D-E, holder-scoped) + the identity-free digest computation
  (FD-5).
- `src/threadline/ConversationStore.ts` — add optional `historyCount/headHash/setAccum`, `collision`
  counter (saturating), the resolver binding; **add a post-commit `closed`-lifecycle hook (via the
  existing `journalSeam`) that deletes the thread log on close** (NOT on LRU/`pruneMapInPlace` eviction —
  a cold-evicted conversation keeps its log; SA5/E1); the head fields are coalesced-cache (debounce
  `headCacheCoalesceMs`, single-flight), never a per-message CAS, and a read never writes back (FD-2/SI1).
- `src/server/routes.ts` — call `recordThreadMessage` at the outbound relay-send local + relay paths and
  the `/messages/relay-agent` inbound fast-path; apply the holder-scoped resolver to outbound threadId
  selection (dry-run-gated); add `GET /threadline/threads/:id` + `/health`; re-point `getThreadHistory`'s
  backing read at the canonical log (D-C); re-point the dashboard observability thread routes at the
  canonical log (E6).
- `src/threadline/ThreadlineEndpoints.ts` — call `recordThreadMessage` on `POST
  /threadline/messages/receive`; recompute/verify `contentDigest`; honor participant-scoped, monotonic
  `threadSync`; handle the participant-authorized bounded backfill request/response kinds; **delete the
  placeholder `GET /threadline/messages/thread/:id` hard-zero path** (D-C).
- `src/threadline/ThreadlineMCPServer.ts` / `mcp-http-client.ts` — `threadline_history` reads the canonical
  log via the re-pointed backing route (no MCP tool signature change).
- `src/messaging/MessageRouter.ts` / `MessageStore.ts` — the canonical log becomes the read source; the
  derived aggregate is retained only as a fast index / inbound backfill source (D-C), not the authority.
- `src/core/ConfigDefaults.ts` + `PostUpdateMigrator.ts` — `threadline.canonicalHistory.*` knobs +
  migrations incl. the **net-new backup-manifest union** for `threadline/conversations.json` (FD-9).
- `src/core/BackupManager.ts` — add `threadline/conversations.json` to `DEFAULT_CONFIG.includeFiles` (FD-9);
  per-thread logs excluded by design.
- `src/scaffold/templates.ts` (`generateClaudeMd`) — Agent Awareness paragraph + proactive trigger.
- Tests across `tests/unit`, `tests/integration`, `tests/e2e` (below).

## Test plan (all three tiers — Testing Integrity Standard)

- **Unit** (`tests/unit/`): `ThreadLog` append/read/verify + chain integrity (tampered line → `brokenAt`;
  **full-rewrite → caught by stamp↔log mismatch**); **idempotency via persisted seen-set** — a duplicate
  replayed AFTER `> seenSetMaxPerThread` intervening entries is still deduped (the regression a tail scan
  would miss); **content-collision** (same key, different `contentDigest` → `collision` marker, no
  overwrite); `contentDigest` is **identity-free + recomputed locally** (a wire digest that disagrees does
  NOT enter the chain); **order-independent accumulator** (same content set in different append orders →
  identical `setAccum`; `count` guard); `version-skew` vs `unverified-peer-legacy` distinction (downgrade
  vector closed); backfilled legs excluded from `setAccum`; head-cache mismatch → rebuilt from log;
  resolver join-vs-fork matrix {no binding→mint; binding + no explicit threadId (outbound)→JOIN; explicit
  fork→mint; different workstreamKey→mint; **different peer→never merge**; **inbound colliding subject→
  never reroutes into a victim thread**; transient lookup-failure→does NOT mint a fresh canonical};
  **retention (SA5):** a `closed` conversation deletes its log; a **cold LRU-evicted conversation KEEPS
  its log** and the next inbound re-hydrates the same log (no F3 regression); pinned keeps it; orphan sweep
  reclaims an unmatched log; **rotation to `archive/` does NOT change `setAccum`/`count`** (SI2);
  **wire-encoding determinism:** `setAccum` over a fixed message set matches a hand-computed reference
  vector (modulus/endianness/hex-padding pinned) and JCS `contentDigest` matches a reference vector
  including a non-ASCII body (the Dawn-reimplementable bytes).
- **Integration** (`tests/integration/`): full HTTP — **F3 regression:** send N then `threadline_history`
  / `GET /threadline/threads/:id` returns all N **including the sender's own outbound**; **wiring
  integrity:** every message-persisting route goes through `recordThreadMessage` (a bypassing route fails);
  **read-source union + memoized backfill:** an empty canonical log whose outbox/aggregate hold legs
  returns those legs (marked `backfilled`, symmetry `unverified-backfill`), and backfill does not re-scan
  on the second read; the placeholder hard-`messageCount:0` path is gone; **health route** 200,
  bearer-gated, own-agent-only, seq-paginated, reports `verified`/`diverged`/`version-skew`/
  `local-integrity-fault` correctly; **backfill authorization (CRITICAL):** a verified peer that is NOT a
  participant of a thread gets EMPTY (never records) + a counted refusal, AND an **identity-claim spoof**
  (verified peer A naming peer B's thread, or asserting B's fingerprint in the body) is refused because the
  participant check uses the fingerprint **derived from the verified signature**, never the name/body
  (SA1); **backfill ingestion (SA4):** a response carrying forged `seq`/`prevHash`/`hash`/`author`/
  `backfilled` is ingested with those fields IGNORED (requester recomputes), and a record whose recomputed
  digest was not in `missingDigests` is dropped + counted; **episode bound (SA2):** a peer streaming N
  messages each with a new unreconcilable leg produces ONE Attention item + at most one backfill round
  total, not N; **traversal:** `:id` with `..`, encoded slash, NUL is 400 and never escapes `threads/`;
  **restore (SI2):** `conversations.json` present + log absent + `backfilled` memo set → backfill RE-runs
  (not a permanently-empty thread); **legacy-peer downgrade:** a message with no `contentDigest`/
  `threadSync` is recorded with a locally-computed digest and symmetry is `unverified-peer-legacy`, not
  `diverged`.
- **E2E** (`tests/e2e/`): "feature is alive" — production init wires the funnel + `GET
  /threadline/threads/:id` returns 200 (not 503); **F3 incident reproduced + fixed** — a sender reads back
  its own ≥4 messages; **F5 incident reproduced + fixed** — a workstream with one verified peer, across a
  simulated restart (ephemeral affinity lost), stays ONE canonical thread under the resolver, and an
  explicit fork DOES create a second; **symmetry end-to-end across the REAL send→receive boundary** — two
  agent instances converge to equal `(count, setAccum)` (proving the identity-free projection matches
  cross-end, NOT a same-process test); an injected missing leg → `diverged` → re-converged via the
  participant-authorized bounded backfill → if unreconcilable, terminal `diverged-unreconcilable` with one
  Attention item and no loop.

## Open questions

*(none)*
