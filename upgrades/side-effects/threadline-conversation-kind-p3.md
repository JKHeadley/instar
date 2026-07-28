# Side-Effects Review — Threadline Conversation Coherence build (P3.1 + P3.2 surfaces)

**Version / slug:** `threadline-conversation-kind-p3`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (implements the 2-round-converged P3 spec; a 4th journal kind riding P1's proven transport; content-free by typed schema; read-only view)`

## Summary of the change

THREADLINE-CONVERSATION-COHERENCE-SPEC (converged 2026-06-06, merged in
#924) — every machine can answer "which machine holds each A2A
conversation, and is it bound to a topic?" from local disk:

1. The 4th journal kind `threadline-conversation` — the spec's honest
   "compiler-guided multi-site edit" performed in full: JournalKind union,
   JOURNAL_KINDS, 6 Record literals (nextSeq/highWaterSeq/opKeys/retention
   merge/rateBuckets/persistMeta), the typed validate() branch
   (action/conversationId/peerFingerprint/topicId? — free text
   structurally excluded, 256-char id bounds), the opKeyOf branch
   ((conversationId, action, topicId?) — conversationId lives in data,
   the round-1 finding), the emitThreadlineConversation emitter, AND the
   JournalSyncApplier.validateData mirror branch (without which the
   receive side suspect-flags the sender). DEFAULT_RETENTION +
   ConfigDefaults literal (8MiB × keep 8; applyDefaults backfills).
2. ConversationStore: the lifecycle emission as a prev/next TRANSITION
   DIFF inside commit() — the store's single write funnel — on `state` +
   `boundTopicId` ONLY (message appends/lastActivity bumps emit NOTHING);
   terminal set = resolved/failed/archived (the real enum);
   setCoherenceJournalSeam + one wiring line at the store's construction
   (journal in scope; emit drops harmlessly when absent/locked-out).
3. NEW route GET /threadline/conversations (?scope=mesh) + the
   ConversationMeshView fold: OWN rows from the LIVE store (the
   authority — own-stream journal entries ignored), replica rows folded
   per-stream last-writer on the composite (holderMachineId,
   conversationId) key under the P1 reader's bounds, with staleness +
   streamStatus + partial-result honesty. 200 with own rows when
   replication is dark; 503 only when the store itself is absent.
4. Agent Awareness on ALL THREE surfaces (template + migrateClaudeMd +
   shadow markers + featureSections tracking): the holder-view trigger
   including the relay's REAL offline bound (in-memory ~24h queue) in the
   honest-answer wording.

## Decision-point inventory

- Transition derivation: first-commit → started (+bound when born
  bound); boundTopicId change → unbound(old)+bound(new); non-terminal →
  terminal → closed. No fingerprint → no emission (nothing coherent to
  record).
- The fold's `unbound` clears the binding; `closed` keeps the row with
  status closed (existence stays answerable).
- Emission failure NEVER reaches the conversation write (observability
  invariant; try/catch at the seam).

## 1-2. Over/Under-block

Over: conversations without peer fingerprints never journal (deliberate).
Under: the P1.2 reader reports streamStatus 'current' always — the
gapped qualifier gains teeth with the P1.3 reader states (the spec's
named dependency); until then partial-result is the honesty signal.

## 3. Fit / 4. Blast radius

The kind rides P1's transport/trust wholesale (proven by the integration
test reusing the journal-sync applier verbatim); the store seam is one
injected callback; the view is read-only. Emission is always-on with the
journal (like every kind); REPLICATION of it rides the existing explicit
gate. A bug can only mis-report holder visibility — nothing actuates off
this view (Signal vs Authority).

## Evidence

- tests/unit/ThreadlineConversationKind.test.ts — 7 passing: schema
  bounds + op-key dedupe; the commit() diff matrix (started/bound,
  rebind unbound+bound naming the OLD topic, closed, non-lifecycle
  emits NOTHING, no-fingerprint emits nothing); the fold (own-live +
  replica last-writer + unbound clears + closed status + local scope).
- tests/integration/threadline-conversation-replication.test.ts — 1
  passing: store lifecycle on A → journal → buildServeBatch → apply on
  B under A's authenticated identity → B's mesh view names A as holder
  with the binding → close converges on the next delta.
- CoherenceJournal (39 incl. the advert test updated for 4 kinds),
  CoherenceJournalReader, JournalSyncApplier suites green;
  feature-delivery-completeness (81) green. Typecheck clean.
