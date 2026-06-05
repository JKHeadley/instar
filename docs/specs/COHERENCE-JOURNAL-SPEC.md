---
title: "Coherence Journal — per-machine append-only event streams (P1 of multi-machine coherence)"
slug: "coherence-journal"
author: "echo"
eli16-overview: "COHERENCE-JOURNAL-SPEC.eli16.md"
status: "draft"
layer: "core-instar-primitive"
parent-principle: "Structure > Willpower — cross-machine awareness comes from a structural event stream, not from any session remembering to report what it did"
parent-spec: "MULTI-MACHINE-COHERENCE-MASTER-SPEC.md"
project: "multimachine-coherence"
project-items: "P1.1 coherence-journal-core, P1.2 topic-placement-history-api, P1.3 journal-peer-replication"
---

# Coherence Journal (P1)

> **One sentence:** every machine keeps a cheap append-only diary of the
> events that matter for cross-machine coordination — topic placement,
> session lifecycle, autonomous-run artifacts — and machines replicate each
> other's diaries over the existing authenticated mesh, so any machine can
> answer "what happened where, and where are the files?" from local disk.

## 1. Motivation (inherited)

Master spec §5-P1. The concrete consumer questions, each a real failure from
the 2026-06-05 record:

- "Which machine was topic 13481 on last night, and why did it move?" —
  today answerable only by grepping one machine's server log (which rotates).
- "The Mini ran an overnight workstream for topic 19437 — where are its
  artifacts?" — today unanswerable from the Laptop (the EXO stranding).
- "Did a session for this topic close on the old machine after the move?" —
  today requires reading reap-log on THAT machine.

## 2. Scope

**In (P1.1–P1.3):** the journal writer library; THREE event kinds wired
(topic-placement, session-lifecycle, autonomous-run); the `journal-sync`
MeshRpc verb + replication loop; `GET /coherence/journal` merged read API;
the machine-readable State-Coherence Registry JSON + new-store CI lint
(master spec §5-P0 enforcement, landing with its first consumer as planned).

**Out (explicitly):** gap-check digests + working-set pull (P2); threadline
event semantics beyond the basic conversation-bound record (P3); replicating
any EXISTING audit stream (reap-log etc. stay machine-local); commitments
store convergence (P1.5 follow-up spec, per Justin's approved
recommendation); any UI beyond the read API.

## 3. Design

### 3.1 The stream

Path: `<stateDir>/state/coherence-journal/<sanitized-machineId>.jsonl`
(sanitization mirrors `MachineHeartbeat`'s `[^A-Za-z0-9_-]` rule; the
`coherence-journal/` dir joins `ensureStateDir()`). Replicated peer copies
land read-only at `.../coherence-journal/peers/<machineId>.jsonl`.

One JSON object per line:

```jsonc
{
  "seq": 412,                        // strictly monotonic per stream, no gaps
  "ts": "2026-06-05T21:40:00.000Z",
  "machine": "m_cc2ec651…",          // author (redundant with filename; survives copies)
  "kind": "topic-placement",         // the taxonomy, §3.2
  "topic": 13481,                    // present when topic-scoped
  "data": { ... }                    // kind-specific, metadata-only
}
```

Writer rules (the journal writer is ONE class, `CoherenceJournal`):
- **Append-only, fsync-on-write, own stream only.** A machine never writes
  another machine's file (single-writer-per-stream ⇒ replication is
  conflict-free by construction).
- **Strictly monotonic `seq`** persisted via the file itself (last line on
  open; a partial trailing line from a crash is truncated on open — the
  recovery test in §6).
- **Metadata only.** Ids, paths, statuses, machines, reasons, timestamps.
  Never message content, never secret-bearing fields; the live-tail
  redaction enum runs over `data` values as defense-in-depth.
- **Never throws into its caller.** A journal-emit failure logs + increments
  a degradation counter; it must never break placement/session/autonomous
  code paths. (Observability must not endanger the observed.)
- **Standby-safe:** journal writes are `sessionScoped`-class (own-stream
  files), permitted on a read-only standby the same way pool session writes
  are — the standby guard exception pattern, scoped to the journal dir.

### 3.2 Event taxonomy (P1 ships exactly these)

| kind | emitted when | data |
|------|--------------|------|
| `topic-placement` | ownership CAS commits (place/claim/transfer/release/failover) | `{ owner, prevOwner?, epoch, reason }` — reason ∈ `user-move` \| `placed` \| `failover` \| `released` \| `quota-block-move` |
| `session-lifecycle` | session created / completed / killed / reaped | `{ sessionId, status, reapReason? }` |
| `autonomous-run` | autonomous job start gate passes / job stops | `{ action: "started"\|"stopped", artifactPaths: [".instar/autonomous/13481.local.md", …] }` — **artifactPaths is the EXO fix's foundation** |

Adding a kind later = append a writer call + a row to the registry; the
format is forward-compatible (readers ignore unknown kinds).

### 3.3 Emission points (grounded)

- **topic-placement:** the ownership CAS chokepoint —
  `SessionOwnershipRegistry` (the store behind `SessionRouter.deps.casClaimOwnership`,
  `src/core/SessionRouter.ts:107,241`) plus the explicit-transfer path
  (`POST /pool/transfer` planner). Emit AFTER the CAS commits, with the
  winning epoch. Every path that mutates ownership goes through the CAS —
  that is the invariant that makes one emit point sufficient; the
  wiring-integrity test (§6) enforces it.
- **session-lifecycle:** `SessionManager` at the three `saveSession`
  lifecycle sites (create / complete / kill) + the reaper's reap event
  (alongside the existing reap-log append — the journal entry references the
  reap-log line, not duplicates it).
- **autonomous-run:** start — at the `can-start` gate's grant (server-side,
  the one structural point every autonomous start passes); stop —
  `AutonomousSessions.stopAutonomousTopic` / `stopAllAutonomousJobs`. The
  started event records the `.local.md` path it will own; a later
  `artifact-declared` data field (same kind, action `artifacts-updated`) lets
  a running session declare additional output paths.

### 3.4 Replication — `journal-sync` verb

New `MeshCommand`: `{ type: 'journal-sync'; watermarks: Record<MachineId, number>; entries?: JournalEntry[] }`
(union at `src/core/MeshRpc.ts:29-36`; RBAC class: any registered peer,
read/observe — same class as `capacity-report`; handler wired in the
`commands/server.ts` mesh dispatcher `handlers` block alongside
`secret-share`).

Loop (piggybacks the existing capacity-heartbeat cadence — no new timer):
1. With each heartbeat exchange, a machine includes its journal watermarks
   `{machineId → highest seq held}` (own + replicated).
2. A peer holding newer entries for any stream responds (or pushes) the
   delta, batched and size-capped (`journalSyncMaxBatchBytes`, default 256KB).
3. Receiver validates: entries for stream M must come in seq order,
   appending only `lastHeldSeq + 1 …` (gaps → hold + re-request; duplicates →
   drop silently). Idempotent under redelivery by construction.
4. Transport authenticity = the existing machineAuth envelope. No journal
   data ever rides Threadline.

**Pull-first:** a machine asks for what it's missing; unsolicited bulk push
is bounded to the heartbeat piggyback (the secret-sync anti-clobber lesson —
and a stale machine can't corrupt anything anyway: it only ever appends to
its OWN stream and serves immutable history).

### 3.5 Read API

`GET /coherence/journal?topic=N&kind=topic-placement&machine=M&limit=100&before=<seq|ts>`
→ merged, ts-ordered view over own + peer streams:
`{ entries: [...], streams: { <machineId>: { lastSeq, lastTs, source: "own"|"replica" } } }`.

- Answers "where did topic N live and when" in one call from ANY machine.
- Degradation rule (master spec §6.4): the journal is plain JSONL on disk —
  the CLI/hooks may read the files directly when HTTP is starved; the route
  is a convenience, not the only door.

### 3.6 Registry JSON + CI lint (the P0 enforcement, shipping here)

- `src/data/state-coherence-registry.json` — machine form of the approved
  registry doc (category → axes → transport). The journal registers itself
  as its first entry.
- `scripts/lint-state-registry.js` — sweeps `src/` for durable-write
  patterns (writeFileSync/appendFileSync/JSONL append/SQLite open targeting
  state dirs); fails CI when a store has no registry entry. Modeled on
  `lint-no-unfunneled-topic-creation.js`. Existing ~100 categories are
  seeded from the census so the lint lands green, with `grandfathered: true`
  markers where the census was uncertain (§4e of the registry doc).

### 3.7 Config & rollout

`.instar/config.json` → `multiMachine.coherenceJournal`:
`{ enabled ?? !!developmentAgent, replication: { enabled ?? same, maxBatchBytes: 262144 }, retention: { maxFileBytes: 16777216, rotateKeep: 4 } }`.
Dark on the fleet, live on echo (the `developmentAgent` gate standard).
Single-machine agents: writer on (cheap, locally useful), replication no-op.
Rotation: size-based rotate with the date-partitioned archive pattern;
watermarks survive rotation (seq continues across files; sync serves from
archive when a peer is far behind).

## 4. Degradation requirements (inherited, master spec §6 — restated as behaviors)

1. `journal-sync` acks only after the receiver's append fsyncs (ack-after-durable-commit).
2. Crash mid-append → truncated partial line repaired on next open; seq
   resumes correctly (kill -9 test).
3. Every verb idempotent under redelivery (seq-gated appends).
4. Journal files readable without the server (plain JSONL; no lock needed
   for readers).
5. Cheap: emits are single-line appends; replication is delta-only,
   batch-capped, heartbeat-cadenced. No scans, ever.

## 5. Security

Master spec §8 verbatim applies: metadata-only entries, redaction enum over
`data`, machineAuth-only transport, registered-peer RBAC. Peer streams are
read-only on disk (mode 0444 after append? — no: receiver appends, so 0644
with the single-writer rule enforced in code + a test).

## 6. Testing (all three tiers + degradation)

- **Unit:** writer (monotonic seq, append-only, crash-repair on open,
  rotation continuity, redaction, never-throws-into-caller); watermark
  merge; seq-gated apply (gap hold, duplicate drop).
- **Integration:** two in-process journals round-trip `journal-sync` deltas
  through the real MeshRpc envelope; `GET /coherence/journal` merged view +
  filters; standby-write permitted via the scoped guard; registry lint green
  on the seeded registry and red on an undeclared synthetic store.
- **E2E:** production-init boots writer + route alive (200-not-503); a
  simulated place→transfer→close sequence yields the correct placement
  history from BOTH machines' read APIs; kill -9 mid-append → clean resume
  (degradation tier).
- **Wiring-integrity:** the CAS chokepoint, the three SessionManager
  lifecycle sites, and both autonomous paths each emit — asserted by tests
  that run those code paths and read the journal (the seamlessness Phase-0
  lesson: unwired sync ships dead).

## 7. Work breakdown (P1.1 → P1.3, one PR each unless trivially small)

1. **P1.1** `CoherenceJournal` writer + emission wiring (placement /
   session / autonomous) + registry JSON + CI lint + unit tests.
2. **P1.2** `GET /coherence/journal` + reading merged streams + integration
   tests. (Small; may ride with P1.1.)
3. **P1.3** `journal-sync` verb + heartbeat piggyback + replication loop +
   E2E across two in-process servers + live two-machine verification
   (Laptop+Mini: move a topic, read its history from both sides).

## 8. Open questions for Justin

1. **Retention horizon** — proposed: size-rotate at 16MB keeping 4 archives
   (~weeks of history). Enough, or do you want placement history effectively
   forever (tiny events; could keep placement kind unrotated)?
2. **Live verification scope for P1.3** — the real two-machine proof
   (move topic, read history from both machines) — fine to run it on your
   live fleet as the closing step, as we did for the pool features?
