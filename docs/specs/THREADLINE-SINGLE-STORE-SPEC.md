---
title: Threadline Single-Store Collapse (Phase 2a / CMT-497)
status: approved
approved: true
approver: justin
approved-at: "2026-05-25T08:49:00Z"
created: 2026-05-24
revised: 2026-05-24
owner: echo
companion-eli16: THREADLINE-SINGLE-STORE-ELI16.md
review-report: "docs/specs/reports/threadline-single-store-convergence.md"
roadmap-phase: 2a
predecessor: THREADLINE-CONVERSATION-KEYSTONE-SPEC.md
tracked-as: CMT-497
---

# Threadline Single-Store Collapse (Phase 2a / CMT-497)

Completes the Phase 1 keystone's acceptance criterion #1 — *the router reads/writes
ONLY the Conversation; no parallel writes* — deferred in Phase 1 because of a
multi-process write pattern. This phase makes `ConversationStore` **cross-process
safe** so it can be the one authoritative store, and retires the live legacy store
(`ThreadResumeMap`) into a view over it. It is the foundation Phase 2b (CMT-493,
the inbox/deliberate-drain reply model) builds on.

> **Approach revised after convergence (2026-05-24).** The first draft proposed an
> HTTP surface so the MCP stdio child could read/mutate via the server as sole
> writer. Two reviewers (grounded against the live code) rejected it: (a) the only
> cross-process *write* is a single `.remove()` call — four authenticated
> endpoints is a heavy lever for one bolt; (b) `/threadline/*` routes BYPASS the
> bearer middleware (`middleware.ts:123-126`), so the endpoints would have shipped
> UNAUTHENTICATED; (c) routing a synchronous local read through a restartable
> server process adds latency, a silent-empty failure mode, and restart-window
> data loss with no durable retry. The convergence recommendation — a file-level
> version-CAS on `ConversationStore`, exactly the cross-process-safe pattern the
> legacy maps already use (reload-per-op + atomic rename), hardened with a version
> field — is adopted instead. No new network surface, no auth gap, no restart-
> window loss. Convergence also found the file-backed `ContextThreadMap` and its
> consumers are DEAD CODE, removing it from scope entirely.

## Problem (why Phase 1 stopped short)

`ConversationStore` (Phase 1) holds state **in memory** (`this.store`) with a CAS
`mutate()` — correct/fast for the loop gate, but a *single-process* design. The
live legacy store it replaces, `ThreadResumeMap`, is written from **two
processes**: the agent server (TopicLinkageHandler, ThreadlineRouter) and the MCP
stdio child (`ThreadlineMCPServer.ts:787` calls `.remove`; reads at :623/:726/:772).
The legacy maps survive this only because they **reload-from-disk per op**
(last-writer-wins, no in-memory state). Two in-memory `ConversationStore` instances
(one per process) would clobber each other's snapshots → data loss. So Phase 1 kept
`ThreadResumeMap` as a parallel store.

**Verified scope (convergence):**
- The cross-process *write* surface is exactly ONE call (MCP child `.remove`) plus
  reads (`.get`, `.getByRemoteAgent`). All `ThreadResumeMap` writers otherwise are
  in-server. (No lifeline/job/CLI/listener writer exists.)
- The file-backed `ContextThreadMap` is **never constructed in production**
  (`new ContextThreadMap` = 0 hits); its only consumers (`A2AGateway`,
  `OpenClawBridge`) are themselves never constructed. The live A2A path uses a
  *different*, in-memory-only `ContextThreadMapper` in the relay-server component.
  → **ContextThreadMap is OUT of scope** (touching it would wire up dead code).
- `ThreadlineObservability.ts:~294` reads `thread-resume-map.json` via a RAW
  `readFileSync` (bypassing the class) — must be re-pointed (see §3).

## Scope (Phase 2a only)

No change to the reply primitive (still spawn-per-message; that's Phase 2b). Pure
store-unification of the ONE live legacy store.

### 1. `ConversationStore` becomes cross-process safe (file version-CAS)

Replace the pure in-memory model with reload-per-op + optimistic version-CAS +
atomic write, the proven cross-process-safe pattern:
- **`mutate(threadId, fn)` (async) and `mutateSync(threadId, fn)`:** reload the
  store from disk → locate the record → snapshot its `version` → apply `fn` → if
  the on-disk `version` is unchanged, write the merged record with `version+1` via
  tmp-write+`rename` (atomic); else reload and retry (bounded, e.g. 8). This makes
  concurrent writers in *different processes* safe — the file is the source of
  truth, the version field is the CAS token, and `rename` prevents torn reads.
- **`get`/`getByParticipant`/`getByTopicId`/`listActive`:** read from disk (a
  very-short-TTL in-process cache, e.g. 250ms, is allowed for the gate's hot path
  — staleness only ever causes a redundant reload on the next `mutate`, never a
  lost write, because `mutate` always re-reads).
- **Ephemeral affinity** stays in-memory + per-instance (explicitly non-durable,
  unchanged from Phase 1).
- The full-file rewrite per mutate is acceptable: inbound agent traffic is
  human-paced and the store is capped (~1000 rows). The 50-concurrent CAS test
  continues to pass (now exercising file-CAS).

This preserves the public API, so the gate/funnel/router/tests are unchanged in
shape. (The Phase 1 in-memory CAS test becomes a file-CAS test — same assertion:
N concurrent increments lose nothing.)

### 2. `ThreadResumeMap` becomes a view over `ConversationStore`

Reimplement `ThreadResumeMap`'s methods against `ConversationStore` (both
processes construct a file-CAS `ConversationStore`; safe per §1), so every existing
caller (`ThreadlineRouter`, `TopicLinkageHandler`, `ThreadlineMCPServer`,
`ThreadlineObservability`) is unchanged in signature. **Explicit field bridge**
(`ThreadResumeEntry` ↔ `Conversation`) — this was the convergence FATAL; it is now
mandatory and exhaustive:

| ThreadResumeEntry | Conversation |
|---|---|
| `uuid` | `sessionUuid` |
| `sessionName` | `boundSessionName` |
| `remoteAgent` | `remoteAgent` (+ `participants.peers[0]`) |
| `subject` | `subject` |
| `state` | `state` |
| `resolvedAt` | `resolvedAt` |
| `pinned` | `pinned` |
| `messageCount` | `messageCount` |
| `createdAt` | `createdAt` |
| `savedAt` | `savedAt` |
| `lastAccessedAt` | `lastActivityAt` |
| `machineOrigin` | `machineOrigin` |
| `migratedTo` | `migratedTo` |
| `spawnMode` | `spawnMode` |
| `originTopicId` | `boundTopicId` |
| `originSessionName` | `originSessionName` |

- **`save` MUST MERGE, not replace** (convergence finding): a legacy `save` carries
  only resume fields; it must not clobber the gate's `turnCount`/`lastInboundHash`
  on the same record. The view maps the entry's fields onto the existing
  Conversation via `mutateSync`, leaving turn/novelty fields intact.
- **Method coverage (exhaustive — all of these are reimplemented on the view):**
  `get`, `save`, `remove`, `resolve`, `pin`, `unpin`, `getByRemoteAgent`,
  `listActive`, `size`, `prune`, `migrateFrom`, `getMigratedEntries`,
  `refreshResumeMappings`. (`pin`/`unpin`/`migrateFrom`/`getMigratedEntries`/
  `refreshResumeMappings` have no live src/ callers today — they are reimplemented
  for parity + the cross-machine failover path, and tested, but flagged as
  not-on-a-live-path so green tests don't imply live exercise.)
- **Resume semantics preserved:** the `jsonlExists(uuid)` guard in `get` and the
  `refreshResumeMappings` heartbeat operate on `sessionUuid`; cross-machine
  `migrateFrom`/`getMigratedEntries` operate on `machineOrigin`/`migratedTo`.

### 3. Re-point `ThreadlineObservability` to the store

`ThreadlineObservability` currently raw-reads `thread-resume-map.json`. Re-point it
to read through `ConversationStore` (or the `ThreadResumeMap` view) so the
dashboard Threadline tab reflects live state, not the frozen legacy file.

### 4. Legacy file retirement

`thread-resume-map.json` is no longer written (all writes go through the view →
`ConversationStore` → `conversations.json`). It is kept on disk one release for
rollback, then removed in a later release. `context-thread-map.json` is untouched
(dead-code path; left as-is).

## Concurrency argument (why this is now safe)

`conversations.json` is now written by both processes, but every write is
reload→version-CAS→atomic-rename. A write only commits if the on-disk version
matches the version read at the start of the op; otherwise it reloads and retries.
`rename` is atomic on POSIX, so no reader sees a torn file. This is the same
guarantee the legacy maps relied on (reload-per-op) PLUS a version token that
upgrades last-writer-wins to lose-no-update. No in-memory snapshot is authoritative,
so there is no cross-process clobber. The async `mutate` and sync `mutateSync` both
go through the same file-CAS; the async fn's await gap is covered because the CAS
re-reads the file's version at commit time. **Invariant (load-bearing):** every
commit path — async and sync — MUST increment `version`; a test asserts a sync
write racing an async increment loses neither.

## Migration parity

Phase 1's `migrateThreadlineConversationStore` already folds the legacy file into
`conversations.json` on boot. This phase adds:
- **Dual-read transition (one release):** the view reads `ConversationStore` first
  and, on a miss, falls back to reading `thread-resume-map.json` directly (so a
  thread written by a pre-2a version is still found), then writes it through to
  `ConversationStore`. **Bounded to in-server reads only**, and because pre-2a
  *writers* are gone after this release deploys, the window cannot re-introduce a
  second live writer (the convergence dual-read concern): an older MCP child that
  still file-writes would only happen across a partial fleet upgrade — documented
  as accepted + the migration reconciles on next boot.
- **Reconciliation:** the resume entry (`sessionUuid` + lifecycle) is authoritative
  for session binding.

## Acceptance criteria

1. `conversations.json` writes are cross-process safe: a test spawns two processes
   (or two `ConversationStore` instances) mutating the same thread concurrently and
   asserts no lost update (file version-CAS).
2. `ThreadResumeMap` is a view over `ConversationStore`; the field-bridge table is
   honored — a round-trip (`save` an entry, `get` it back) preserves EVERY field,
   incl. `uuid`→`sessionUuid` and `sessionName`→`boundSessionName`.
3. `save` MERGES: a legacy `save` on a thread that has gate `turnCount`/
   `lastInboundHash` does NOT clobber them.
4. Resume works end-to-end: a killed-then-resumed thread recovers its session
   (jsonlExists + the resume path), driven against real session UUIDs.
5. `mutateSync` racing async `mutate` loses no update (both bump version).
6. `ThreadlineObservability` reflects live `ConversationStore` state, not the frozen
   legacy file.
7. Migration dual-read finds a pre-2a thread on miss; reconciliation loses no
   binding. Cross-machine `migrateFrom` semantics preserved on the view.
8. No second file-backed writer of thread state remains (wiring-integrity);
   `ThreadResumeMap` no longer persists to `thread-resume-map.json`.
9. Full 3-tier tests; Zero-Failure.

## Test-as-self acceptance gate (REQUIRED before production)

Per the now-standard gate (first applied on the Phase 1 keystone): before merge,
deploy to a live co-located agent (`instar-codey`) and validate LIVE that (a) the
MCP child's thread tools (history/agents/delete) still work with the file-CAS store
written by both processes, (b) a real resume recovers the session, (c) no
`conversations.json` corruption under concurrent gate + MCP-child activity (drive an
inbound while calling threadline_delete), (d) the dashboard Threadline tab shows
live state. Iterate, restore the agent to released code, THEN merge.

## Rollback

Additive + reversible. Revert = restore `ThreadResumeMap`'s file-backed
implementation + the Observability raw read + the in-memory `ConversationStore`.
The frozen legacy file is still current within the dual-read window, so rollback
strands no state.

## Testing

- Unit: file-CAS `mutate`/`mutateSync` (incl. two-instance concurrent race);
  `ThreadResumeMap`-view field-bridge round-trip (every field) + merge-not-clobber;
  `migrateFrom`/`refreshResumeMappings` parity.
- Integration: MCP-child tool calls (history/agents/delete) against a file-CAS store
  written concurrently by a simulated server writer — no corruption; resume path.
- E2E: feature-alive (store + view live on prod init path); resume-after-kill
  lifecycle; observability reflects live state.

## Roadmap (NOT deferred — tracked)

- **Phase 2b (CMT-493):** the inbox/deliberate-drain reply primitive + first-contact
  "Agent Conversations" surface + scale decoupling + MoltBridge first-contact, built
  on this single store. <!-- tracked: CMT-493 -->
