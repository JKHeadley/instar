---
title: "Conversations suggestions: the owner's decisions reach every machine"
slug: conversation-graph-suggestions-replicated-decisions
parent-spec: docs/specs/conversation-graph-suggestions.md
eli16-overview: docs/specs/conversation-graph-suggestions-replicated-decisions.eli16.md
tier: 2
author: echo
created: 2026-11-17
closes: CMT-1650
---

# Conversations suggestions: the owner's decisions reach every machine

This is a delta to `docs/specs/conversation-graph-suggestions.md` (approved 2026-11-11). It replaces that spec's §5 ("Multi-machine posture"), which declared all suggestion state machine-local and tracked this change as CMT-1650. Nothing else in the parent spec changes. The parent's approval covered a machine-local design only, so this delta needs its own convergence and approval before code.

Wording note: the owner chose "group" as the user-facing word on 2026-11-17 (was "effort"). Internal names (`effort`, `create-effort`, the `conversation-graph-suggestions.json` file) are unchanged. This spec says "group" when it means what the person sees.

## 1. Problem

The suggestion step remembers three owner decisions per suggestion id in `.instar/state/conversation-graph-suggestions.json` on the machine that served the request:

- `rejected[id]` — the owner tapped Reject. The parent spec promises it is "never offered again".
- `accepted[id]` — every Accept step finished. Never offered again.
- `accepting[id] = { createRequestId, startedAt }` — an Accept has started. The server-minted `createRequestId` is the idempotency key of the owner's `create-effort` request, so a reload, a second tab or a later visit continues the same request and gets the same group (parent §4).

When the agent runs on more than one machine, the dashboard can be served by any of them (the lease holder changes, or the owner opens a different machine's dashboard). Today:

1. A rejection made on machine A is unknown to machine B. B's next build can offer the same grouping again. This breaks the parent spec's "never offered again" promise to the owner.
2. An Accept started on A and continued on B mints a second `createRequestId` on B, so B's Continue creates a second, empty group instead of continuing the first.
3. An accepted suggestion is unknown to B. B withdraws it anyway once its members are placed (parent §3: "a suggestion any of whose members is no longer an unassigned visible conversation is withdrawn"), so this one is mostly cosmetic, but a project suggestion (single member, the front door) can reappear until the front door placement replicates.

## 2. What already exists (no new transport)

- The WS2 replicated-record path: `ReplicatedRecordEmitter` (send side) + `ReplicatedKindRegistry` (kind → store + schema) + `CoherenceJournal.emitReplicatedRecord` (own stream) + the journal sync applier (peer streams) + `ReplicatedPeerStreamReader` (the union read). Spec: `docs/specs/WS2-SEND-SIDE-EMISSION-SPEC.md`, `docs/specs/multi-machine-replicated-store-foundation.md`.
- Its recent consumers with the same shape as this one: the Work Board (`work-card-record`, `src/core/WorkCardStore.ts`) and the trust journey (`trust-grant-record`, `src/core/trustJourney/TrustJourneyStore.ts`). Both use immutable records, fold the union deterministically, and are fed by the two commit observers in `src/commands/server.ts` (`coherenceJournal.setReplicatedRecordCommitObserver` for own records, `journalSyncApplier.setReplicatedRecordCommitObserver` for peers'). The trust journey is "forced on wherever the journal runs"; with the journal off it writes a local file instead (the sink pattern).

This change is one more consumer of that path. It adds no endpoint, no peer route and no transport.

Not chosen: the conversation graph's own replication (`ConversationGraphReplicationRuntime`). Suggestions are advice and the parent spec forbids them being graph events ("it is never a graph event, so it can never place, move or hide anything"). The graph path also carries witness custody and owner-proof machinery that a "do not show this again" mark does not need.

## 3. Design

### 3.1 What replicates and what stays local

| State | Posture | Why |
|---|---|---|
| `rejected`, `accepted`, `accepting` (the owner's decisions) | **Replicated** as `conversation-graph-suggestion-record` | The owner made them; every machine must honor them. |
| `suggestions` (the built list), `builtAt`, `lastAttemptAt`, `lastFailure` | **Machine-local by design** (unchanged) | Advice regenerated from shared inputs (unassigned conversations, project bindings, summaries). Each machine builds its own on its own spend budget. Titles and reasons never leave the machine. |

### 3.2 The record

- Journal kind `conversation-graph-suggestion-record`, store key `conversationGraphSuggestions`. Added to `JournalKind` / `JOURNAL_KINDS`, the per-kind retention defaults and sequence tables in `CoherenceJournal.ts`, and registered with the `ReplicatedKindRegistry` next to the other registrations in `server.ts`.
- One immutable record per (suggestion id, decision). `recordKey = "<suggestionId>:<decision>"`, `op: 'put'`, HLC and origin from the emitter. No updates, no tombstones: a decision once made is never withdrawn by this feature (the parent spec has no "un-reject").
- Fields (exact, validated by the store schema; a record with any other field, or a malformed one, is rejected by the envelope machinery and counted, never repaired):
  - `suggestionId` — `^sg-[a-f0-9]{20}$` (the parent's `suggestionId`/`projectSuggestionId` format).
  - `decision` — `'rejected' | 'accepted' | 'accepting'`.
  - `at` — ISO time the owner acted on the serving machine.
  - `createRequestId` — present only when `decision === 'accepting'`; `^suggestion-[0-9a-f-]{36}$`.
- No titles, member keys, reasons or conversation content. The suggestion id is a hash of member keys, so a record discloses nothing a peer machine of the same agent could not derive.

### 3.3 The fold

`foldSuggestionDecisions(entries)` is a pure function over the union (own + peer records), plus this machine's local file:

- `rejected` = the set of ids with any `rejected` record, local or replicated.
- `accepted` = the set of ids with any `accepted` record, local or replicated.
- `accepting[id]` = the `createRequestId` of the **earliest-HLC** `accepting` record for that id (ties by origin id, the registry's total order). The local file's `accepting` entry counts as a record with this machine's HLC at write time. Earliest wins so that every machine converges on the request the first Accept used.
- A suggestion is offerable only if it is in none of `rejected` or `accepted`. Precedence for display: rejected or accepted hides it; otherwise `accepting` shows Continue.

`ConversationGraphSuggestionService.load()` returns the local file overlaid with the fold. `offerableSuggestions` and the build filter (parent §3 "nothing the owner rejected", "members of a started Accept are left out of later builds") read the folded sets, so a peer's rejection both hides the suggestion here and keeps the model from proposing it again here.

### 3.4 Writes

`reject`, `start` and `accepted` keep writing the local file first (it remains the single-machine sink and this machine's immediate truth), then emit the record through the emitter.

- `start` on a machine whose fold already holds an `accepting` entry for that id returns that entry's `createRequestId` and emits nothing. This is the fix for problem 2.
- An emit result other than `emitted` is not silent: it is reported through `DegradationReporter` (feature `ConversationGraphSuggestions.replication`, internal-only) and retried by the backfill in §3.5. The owner's action still succeeds on this machine; the decision is a signal for other machines, never a gate on this one.
- With the coherence journal off (single machine), nothing is emitted and behavior is byte-for-byte today's.

### 3.5 Backfill of decisions made before the upgrade

At boot, and once an hour while running, the service emits a record for each local `rejected`, `accepted` and `accepting` entry whose `recordKey` this machine has not yet seen in its own stream (read from the union). Idempotent by `recordKey`: a second emit of the same key is a duplicate the fold ignores. This also carries decisions whose first emit failed.

### 3.6 Enablement

Forced on where both the coherence journal runs and the conversation graph read surface is enabled (`conversationGraph.read.enabled` resolved true), like the trust journey's store. Rationale: it only adds the owner's own decisions to other machines; it restricts nothing for any agent ("updates never restrict existing agents"), and it costs a few hundred bytes per decision. A kill switch, `multiMachine.stateSync.conversationGraphSuggestions.enabled: false`, turns emission off; reads of already-received records keep working.

### 3.7 Mixed versions

A peer on an older build does not register the kind and ignores these records (a new registered kind is additive; no unknown-field surface on any stream it reads). That peer keeps today's machine-local behavior until it upgrades. The dashboard served by an upgraded machine is correct; the old machine's dashboard may still re-offer. This is stated in the upgrade note.

## 4. Residual risks (honest)

- **Concurrent first Accept on two machines** inside the replication window (seconds): two `accepting` records with different request ids. The fold converges on the earliest, but if the later machine's `create-effort` already committed, one extra empty group exists. The owner can forget its name or leave it empty; no conversation is moved into it, because the later machine's subsequent steps read the folded `createRequestId` on Continue. Not prevented, because prevention would need a cross-machine lock for advice.
- **A rejection on a machine that is offline** reaches the others when it reconnects (journal catch-up). Until then the others may offer it. Same window as every WS2 store.
- **Retention**: records are never compacted away while the suggestion could be rebuilt. Volume is bounded by the parent's limits (at most 8 suggestions per build, builds at most every 10 minutes manually or every 24 hours automatically, and only owner taps create records). Retention default: `maxFileBytes: 2 MiB, rotateKeep: 0` like other small owner-decision kinds.

## 5. Signal vs authority

No decision point is added. The records are the owner's own decisions carried to other machines; they hide advice. They never place, move, hide or send a conversation, never gate an owner action, and a missing or late record only means advice may be offered again.

## 6. Tests (all three tiers)

- Unit: schema validate (accepts each decision shape; rejects extra fields, bad id format, `createRequestId` on a non-accepting record); fold (rejected from a peer hides; accepted from a peer hides; earliest-HLC `accepting` wins regardless of arrival order; local + replicated merge); service `start` reuses a replicated `createRequestId`; emit failure reports and the backfill re-emits; journal off emits nothing.
- Integration: two in-process services sharing a fake union: reject on A, `GET /conversation-graph/suggestions` on B does not offer it, and B's next build excludes it from the model prompt's offered set.
- E2E: the production wiring in `server.ts` registers the kind and wires both commit observers; with the journal on, a reject emits one record on the own stream.

## 7. Rollback

Set `multiMachine.stateSync.conversationGraphSuggestions.enabled: false` (stops emission), or revert the release. Local files are unchanged by this feature (it only adds an overlay), so a revert returns every machine to today's machine-local behavior with no data repair. Records already in journals are inert to builds without the kind.

## 8. Parent spec §5, replacement text

> ## 5. Multi-machine posture
>
> The built list of suggestions is machine-local by design: it is advice regenerated from shared inputs, and each machine builds its own. The owner's decisions (rejected, accepted, an Accept in progress and its request id) replicate to every machine as `conversation-graph-suggestion-record` on the WS2 replicated-record path (spec `conversation-graph-suggestions-replicated-decisions.md`), so a rejection on one machine is honored on every machine and an Accept continued on another machine continues the same request. The graph changes an Accept makes are the ordinary replicated owner events.
