---
title: "Coherence Journal — per-machine append-only event streams (P1 of multi-machine coherence)"
slug: "coherence-journal"
author: "echo"
eli16-overview: "COHERENCE-JOURNAL-SPEC.eli16.md"
status: "approved"
approved: true
principal-signoff: 'Justin, 2026-06-05 20:34 PDT (topic 13481): "approved!" — in response to the convergence-gate ask (A: approve converged spec + build P1.1-P1.3; C: live two-machine proof on the fleet as the P1.3 closing step). Convergence report + rendered ELI16 delivered and linked in PR #875.'
layer: "core-instar-primitive"
parent-principle: "Structure beats Willpower — cross-machine awareness comes from a structural event stream, not from any session remembering to report what it did"
parent-spec: "MULTI-MACHINE-COHERENCE-MASTER-SPEC.md"
project: "multimachine-coherence"
project-items: "P1.1 coherence-journal-core, P1.2 topic-placement-history-api, P1.3 journal-peer-replication"
supervision: "tier0 — replication is deterministic metadata transport with no policy decision; seq-gating and write-side schema validation are programmatic gates. Justified per LLM-Supervised Execution: no judgment calls exist in this pipeline."
lessons-engaged: >
  Engaged: Structure>Willpower (P1); Signal vs Authority (P2 — journal is signal-only,
  structural actuation ban §3.9); Migration Parity (P3 — §3.8); Agent Awareness (P5 — §3.8);
  LLM-Supervised Execution (P7 — tier0 declared); Distrust Temporary Success (P14 —
  truncate-on-open surfaced, §4.2); No Unbounded Loops (P19 — gap backoff + breaker §3.4);
  ack-after-durable-commit (§4.1); idempotent-redelivery (§3.4, §3.3-keys);
  per-entry-files-vs-shared-JSONL (#827 — per-machine-per-kind streams are that lesson applied);
  committed-generated-file conflict loop (#776 — registry JSON is authored, not generated).
  Declined: artifacts-updated live declarations (willpower-dependent; deferred to P2's
  working-set manifest where it becomes structural) <!-- tracked: multimachine-coherence-topic-working-set-manifest -->.
review-convergence: "2026-06-06T03:07:30.583Z"
review-iterations: 4
review-completed-at: "2026-06-06T03:07:30.583Z"
review-report: "docs/specs/reports/coherence-journal-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
---

# Coherence Journal (P1)

> **One sentence:** every machine keeps a cheap append-only diary of the
> events that matter for cross-machine coordination — topic placement,
> session lifecycle, autonomous-run artifacts — and machines replicate each
> other's diaries over the existing authenticated mesh, so any machine
> **that has synced with the author** can answer "what happened where, and
> where are the files?" from local disk. (Replication is first-hop-only,
> §3.4 — the claim assumes machines regularly connect pairwise, which the
> 30s presence pull provides on any normally-connected fleet. Journal
> completeness is **best-effort within the flush window**: a crash can lose
> the last ≤250ms of enqueued entries permanently — the journal is an
> audit/diagnosis surface, not a transaction log, per §3.9.)

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
(master spec §5-P0 enforcement, landing with its first consumer as planned);
the Migration-Parity and Agent-Awareness deliverables for all of the above
(§3.8).

**Out (explicitly):** gap-check digests + working-set pull (P2); threadline
event semantics beyond the basic conversation-bound record (P3); replicating
any EXISTING audit stream (reap-log etc. stay machine-local); commitments
store convergence (P1.5 follow-up spec, per Justin's approved
recommendation <!-- tracked: CMT-1116 -->); live `artifacts-updated` declarations from running sessions
(willpower-dependent as proposed; becomes structural in P2's working-set
manifest <!-- tracked: multimachine-coherence-topic-working-set-manifest -->);
transitive replication (machine B relaying machine C's streams — first-hop
only in P1, see §3.4); dashboard surface (master §5-P1 names one; P1 ships
the read API as the contract a later P-item's dashboard tab consumes —
deliberate deferral <!-- tracked: multimachine-coherence-pool-wide-cross-topic-awareness -->).

## 3. Design

### 3.1 Streams — per machine, PER KIND

Path: `<stateDir>/state/coherence-journal/<sanitized-machineId>.<kind>.jsonl`
(sanitization mirrors `MachineHeartbeat`'s `[^A-Za-z0-9_-]` rule — it
percent-encodes, so it is injective and traversal-safe; the
`coherence-journal/` dir joins `ensureStateDir()`). Replicated peer copies
land at `.../coherence-journal/peers/<machineId>.<kind>.jsonl`. A sidecar
`<machineId>.meta.json` holds the stream set's **incarnation token** (§3.4).

**Why per-kind files (changed in convergence):** `session-lifecycle` is
high-volume; `topic-placement` is tiny and is the headline consumer. In one
shared file, size rotation evicts placement history under session churn —
the exact question the journal exists to answer would evaporate first.
Per-kind streams give each kind its own retention (§3.7) and make the
common `topic=N` placement query read one small file. (This is also the
#827 per-entry-files lesson applied at the stream level.)

One JSON object per line:

```jsonc
{
  "seq": 412,                        // strictly monotonic per stream (per machine+kind)
  "ts": "2026-06-05T21:40:00.000Z",  // author wall-clock — DISPLAY ONLY, may skew (§3.5)
  "machine": "m_cc2ec651…",          // author (redundant with filename; survives copies)
  "kind": "topic-placement",
  "topic": 13481,                    // present when topic-scoped
  "data": { ... }                    // kind-specific, TYPED schema (§3.2) — no free text
}
```

Writer rules (the journal writer is ONE class, `CoherenceJournal`):

- **Hot-path emits are non-blocking memory operations — NO synchronous I/O
  in the caller's stack, ever.** `emit()` validates + enqueues in memory and
  returns in microseconds; a background flusher drains the queue with
  single-line `O_APPEND` writes and batched `fdatasync` on a cadence
  (default 250ms) — never inside a placement/session/autonomous code path.
  This is the load-bearing safety rule: the host has a documented
  event-loop-starvation history (master §6), and a blocking `fsync` at the
  CAS chokepoint would reproduce the originating incident class. Durability
  before ack lives on the replication RECEIVER (§4.1), not the author's hot
  path. A fault-injection test wedges the flusher and asserts `emit()` still
  returns immediately (§6).
- **Append-only, own streams only.** A machine's writer only writes its own
  `<machineId>.<kind>.jsonl` files (single PRODUCER per stream ⇒ replication
  is conflict-free by construction for honest participants; the enforcement
  against dishonest ones is §3.4's receiver validation).
- **Single-process guard.** Hosts run multiple agent processes and restart
  storms overlap process lifetimes. The writer takes an advisory lockfile
  (`<machineId>.lock`) at construction; a second process that cannot acquire
  it disables its journal writer — it never blocks the operation being
  journaled and never appends without the lock (two appenders would tear
  lines and fork `seq`). Lock contention is SURFACED, not just logged: the
  disabled state appears in the read API's `streams` status
  (`writer-locked-out`) and the degradation counters, because a writer
  silently disabled during a restart storm is the journal going blind at
  exactly the moment that matters. (A local IPC forwarder to the lock
  holder is an explicit non-goal for P1 — restart-storm overlap windows
  are seconds, and the loser's events are mostly re-observable.) Each
  append is one complete line in a single `write(2)` call (atomic for
  O_APPEND at these sizes).
- **Strictly monotonic `seq`, assigned at ENQUEUE time.** The writer seeds
  an in-memory `nextSeq` counter at open (from the file's last line, cross-
  checked against `meta.highWaterSeq`, §3.4) and assigns seqs as entries are
  enqueued; the flusher writes lines in seq order. On a crash, enqueued-but-
  unflushed entries are LOST and seq resumes from the durable tail — author-
  side durability is explicitly best-effort (the flush window, default
  250ms, is the accepted loss bound; durability-before-ack lives on the
  replication receiver, §4.1). A partial trailing line from a crash is
  truncated on open — and **every actual truncation increments the
  degradation counter and emits a one-time repair signal** (a silently-
  recurring repair is a root-cause symptom, not a success — Distrust
  Temporary Success). Trailing-partial repair is NOT a stream reset; the
  reset trigger is defined precisely in §3.4 rule 3.
- **Per-entry size cap** (default 8KB) and **per-kind emit rate cap** (token
  bucket; over-cap emits drop + count). A runaway caller can flood neither
  the disk nor the replication channel.
- **Operation-keyed idempotency — RESTART-PROOF.** Retried operations must
  not double-emit: each kind declares an operation key — `topic-placement`:
  `(topic, epoch)`; `session-lifecycle`: `(sessionId, status)`;
  `autonomous-run`: `(topic, runId, action)`. The writer keeps a
  recent-window key index that is **reconstructed on open by tail-scanning
  the last N lines of each kind's current file** (bounded, deterministic) —
  an in-memory-only window would evaporate on exactly the restart the guard
  exists for (the 200-then-lost / serial-restart class retries operations
  ACROSS restart boundaries; the CAS is idempotent on epoch — the journal
  must be too, including across its own restarts). Defense-in-depth: the
  read-API merge collapses multiple `topic-placement` entries sharing one
  `(topic, epoch)` to the first-seen, so even a dedupe miss cannot
  double-count a move downstream.
- **Metadata only, BY CONSTRUCTION.** `data` accepts only the typed per-kind
  schema in §3.2 — enum-constrained strings, numeric ids/epochs, validated
  paths. Unknown fields are DROPPED at write time (counted). Free-text
  content structurally cannot enter the stream; the live-tail redaction enum
  still runs over the surviving values as a *secondary* pass, but it is not
  the boundary (it only matches credential shapes and cannot see content
  leaks — Signal vs Authority applied to a filter).
- **`artifactPaths` are jailed at WRITE time.** Each path must canonicalize
  (resolve + realpath containment) under an allowlisted root
  (`.instar/autonomous/`, the agent state dir); `..` segments, absolute
  paths outside the jail, and symlink escapes are rejected (counted). P2's
  working-set pull treats the journal's declarations as fetch targets — the
  jail must exist where the data is BORN, so P2's own path-jail becomes
  defense-in-depth rather than the only line.
- **Never throws into its caller**, and — equally binding — never *slows*
  its caller (the non-blocking rule above). A journal failure of any class
  logs once, counts, and the observed operation proceeds untouched.
- **Standby-safe via a DEDICATED, PUBLIC guard entrypoint.**
  `CoherenceJournal` performs its own file I/O (it is not a StateManager
  method), so the seam is explicit: the flusher calls a new **public
  `StateManager.guardJournalWrite(path)`** before each append batch. That
  entrypoint permits journal writes on a read-only standby **independent of
  `_sessionPoolActive`** (the existing private `guardWrite`'s
  `sessionScoped` exception only opens when the pool is live — reusing it
  would silently disable the journal on exactly the quiet-standby topology
  the EXO incident happened on) and enforces the allowlist: precisely two
  canonicalized path prefixes — own streams
  (`coherence-journal/<thisMachineId>.*.jsonl` + meta/lock sidecars) and
  replica appends (`coherence-journal/peers/*.jsonl`). A path escaping
  those prefixes is refused (test in §6). Centralizing the decision in
  StateManager keeps read-only-mode knowledge in one place and gives the §6
  test a concrete symbol.
- **The journal subsystem never emits journal events about itself.** The
  replication loop, sync handler, read route, and flusher are excluded
  emission sources — enforced by a test that runs a full sync round and
  asserts zero new entries result (no self-reinforcing loops).

### 3.2 Event taxonomy (P1 ships exactly these — typed schemas)

| kind | emitted when | data (typed; unknown fields dropped) |
|------|--------------|--------------------------------------|
| `topic-placement` | ownership CAS commits (place/claim/transfer/release/failover) | `{ owner: MachineId, prevOwner?: MachineId, epoch: number, reason: "user-move"\|"placed"\|"failover"\|"released"\|"quota-block-move" }` |
| `session-lifecycle` | session created / completed / killed / reaped | `{ sessionId: string, status: "created"\|"completed"\|"killed"\|"reaped", reapReason?: <reap-log reason enum>, reapLogRef?: string }` |
| `autonomous-run` | autonomous run observed started / stopped | `{ action: "started"\|"stopped", runId: string, artifactPaths: string[] /* jailed, §3.1 */ }` — **artifactPaths is the EXO fix's foundation** |

Adding a kind later = a typed schema + a writer call + a row to the
registry; readers ignore unknown kinds (forward-compatible).

### 3.3 Emission points (grounded — corrected in convergence)

- **topic-placement:** the commit point is
  **`SessionOwnershipRegistry.cas` returning ok** — pinned by SYMBOL, not
  line number — but the journal `reason` is NOT derivable inside `cas()`
  (it only sees `OwnershipAction`; `failover` lives on the mesh command at
  the `ownAction` wrapper, and user-move / load-placed / quota-block-move
  are placement-policy knowledge upstream of the CAS). So the emit is a
  **thin wrapper at the CAS call sites**: each caller passes its known
  `reason` + the CAS-returned record (epoch, owner, prevOwner) to one
  `emitPlacement()` helper immediately after a successful commit. The
  invariant — *every ownership mutation, including failover, passes through
  the CAS funnel* — is enforced two ways in §6: a wiring test drives
  place/transfer/release/failover paths and cross-checks the journal
  against the CAS's own returned epochs (an independent oracle, not the
  journal verifying itself), and a lint sweeps for ownership-store writes
  outside the funnel AND for `cas(` call sites missing the paired
  `emitPlacement` (same pattern as the registry lint; carve-outs pinned:
  the `cas(` method DEFINITION line is excluded, emits are counted per
  `cas(` token not per function — the mesh `ownAction` dispatcher packs
  four calls in one body — and the injected `casClaimOwnership(` token is
  in the funnel-token set alongside literal `cas(`). REASON PRECISION,
  stated honestly: a machine applying an inbound mesh `place` cannot know
  the originating policy reason (user-move vs quota-block) — it records
  the coarse `placed`; the ORIGINATING machine's own `emitPlacement`
  carries the precise reason in its own stream, and the merged read view
  therefore contains both. Threading origin-reason through the mesh
  command is explicitly out of P1. WHY wrapper+lint over widening `cas()`
  to accept a reason param: `cas` is a storage primitive — placement-policy
  vocabulary (`user-move`, `quota-block-move`) does not belong in the
  ownership store's API, and an optional param would be exactly the
  forgettable willpower surface the lint exists to close; the lint makes
  call-site completeness structural instead.
- **session-lifecycle:** NOT "the three saveSession sites" — `SessionManager`
  has eleven `saveSession` callsites and naming three would ship holes. P1.1
  factors a single **`recordLifecycle(sessionId, status)` funnel** that the
  status-transition sites call; the journal emit lives inside the funnel.
  The reaper's reap event emits alongside the existing reap-log append and
  carries `reapLogRef` (references, not duplicates). The wiring test asserts
  per *transition type* (created/completed/killed/reaped) by driving real
  code paths.
- **autonomous-run:** there is NO single server-side start funnel today
  (the `can-start` route is a read-only preview; `.local.md` files are
  written by several paths including agent sessions directly), and
  `AutonomousSessions` is a module of on-demand pure functions — no
  background loop exists to "observe" anything. P1.1 therefore adds a
  small dedicated **journal scanner** (a `setInterval` wired in server
  startup, default 60s) that calls the existing `activeAutonomousJobs`
  reader and diffs against an in-process seen-set: a newly-appeared active
  `.local.md` emits `started`; a previously-seen one that became
  inactive/absent emits `stopped` with reason `observed-stopped` — so every
  `started` gets a terminating event even when the run dies outside the
  stop funnels (crash, reboot, reaper kill), never a phantom-live run.
  Keys: `(topic, runId)` where `runId` derives from the file's `started_at`
  + topic (stable across rescans ⇒ the operation-key dedupe makes
  observation idempotent). The scanner's `.local.md` parser is the
  EXISTING `AutonomousSessions` reader (single source of truth — no second
  parser), with tolerant reads (a torn/partial file skips that tick). The
  scanner's No-Unbounded-Loops posture, declared: constant per-tick cost
  (bounded by `maxConcurrent` active runs); a throwing or hung read skips
  the tick + counts, never compounds; the seen-set evicts a run after its
  `stopped` is emitted (bounded by currently-active runs, not history);
  emits inherit the writer's rate cap. Polling is chosen over a
  write-funnel deliberately: no single `.local.md` write funnel exists
  (agent sessions write the file directly), so a funnel-side emit would
  re-create the willpower dependency. LIMITATION, stated: a run that
  starts AND stops within one scan interval is not observed — acceptable
  for P1 (autonomous runs are hours-long; the scanner exists for artifact
  discoverability, not auditing). Explicit stops ALSO emit directly in the real funnels
  `stopAutonomousTopic` / `stopAllAutonomousJobs` (module-level functions —
  the journal handle is threaded as a parameter to ALL their callers:
  the routes layer AND `TelegramAdapter`'s stop path; op-key dedupe
  collapses funnel-stop + observed-stop into one entry). The started event
  records the `.local.md` path; live `artifacts-updated` declarations are
  OUT of P1 (§2).

### 3.4 Replication — `journal-sync` verb (first-hop only, validated apply)

New `MeshCommand`: `{ type: 'journal-sync'; advert?: WatermarkAdvert; request?: DeltaRequest; entries?: JournalEntry[] }`
(extends the `MeshCommand` union in `src/core/MeshRpc.ts` alongside
`secret-share`; RBAC class: any registered peer, read/observe — same class
as `capacity-report`; handler wired in the `commands/server.ts` mesh
dispatcher `handlers` block).

**Trust model (set in convergence — the load-bearing rules):**

1. **First-hop only.** A machine serves ONLY its own streams. The receiver
   accepts an entry only when `entry.machine === env.sender` (the
   authenticated envelope identity) and derives the target replica file
   from `env.sender` — NEVER from any in-payload field. A peer shipping
   entries stamped with a third machine's id (or watermarks for one) is
   rejected per-entry + counted. Transport auth says who SENT the envelope;
   it says nothing about who AUTHORED the entries — so in P1 those are
   forced to be the same machine. (Transitive relay needs per-entry
   signatures; that is explicitly out until a phase needs it.)
2. **Schema-validated apply, with a defined recovery.** Before appending,
   the receiver validates every entry: parseable JSON ≤ the size cap, `seq`
   exactly `lastHeldSeq + 1`, `ts` parses, `kind` known-or-ignorable,
   `machine` binding per rule 1, `data` passes the kind's typed schema. ANY
   failure marks that peer stream `suspect`, stops the batch (nothing
   partial is appended beyond the last valid line), and counts — a peer's
   torn write or buggy writer must not poison every reader's merged view
   downstream. **`suspect` is NOT a one-way latch:** it clears back to
   `current` after K consecutive valid in-order applies from that stream
   (default K=20) — a transient cause (the peer's own crash-repaired torn
   line) must not pin a healthy, advancing stream as scary-flagged forever.
   (Distinct from the incarnation quarantine in rule 3, which is
   intentionally sticky until reconciled.)
3. **Incarnation-fenced seqs — with a PRECISE trigger and a BOUNDED
   response.** Seq alone cannot survive restore-from-backup (a restored
   machine re-numbers live events with already-seen seqs, and a naive
   "duplicates → drop" rule would discard its real new history on every
   peer FOREVER, silently). Each machine's stream set carries an
   **incarnation token** (random, minted at stream creation, persisted in
   `<machineId>.meta.json` alongside a per-kind **`highWaterSeq`**). The
   meta write-ordering is PINNED, crash-safe: the flusher appends +
   fdatasyncs the data lines FIRST, then advances `meta.highWaterSeq`
   (atomic temp-file rename) — so `durable_tail ≥ highWaterSeq` holds by
   construction at every instant, including a kill-9 between the two
   steps. The re-mint trigger is therefore exact with ZERO tolerance:
   re-mint IFF on open the file's last seq is strictly below
   `meta.highWaterSeq` — only a genuine rewind (restore) can produce that
   state. A trailing-partial-line repair is a repair, NEVER a re-mint —
   otherwise every kill-9 would flap the incarnation (§6 tests the
   kill-9-between-data-sync-and-meta-write window explicitly: no re-mint).
   Corollary for replication: the advert reflects ONLY durably-flushed
   seqs — queued/unflushed entries are never advertised or served (a §6
   test asserts it), so a crash that loses the queue can never have leaked
   those seqs to a peer. Watermarks
   are `{ machineId → { kind → { incarnation, lastSeq } } }`. A receiver
   seeing a known machine with a NEW incarnation quarantines the old
   replica (renamed aside), starts fresh, and emits a LOUD divergence
   signal — never a silent drop, never a silent merge of two histories onto
   one seq line. **Bounded, like everything else (No Unbounded Loops):**
   at most 2 quarantined replicas are retained per stream (oldest evicted);
   divergence signals for one machine are coalesced within a window; a
   machine that flips incarnations repeatedly past a threshold is marked
   `reset-flapping` and surfaced ONCE (the §6 sustained-failure test drives
   repeated flips and asserts bounded disk + bounded signals).
4. **Truncation is a signal, not silence.** Watermark adverts carry
   `oldestRetainedSeq` per stream. A receiver whose `lastHeldSeq + 1` falls
   below it records a gap sentinel ("seqs N–M rotated out before
   replication"), fast-forwards its watermark, and resumes — the read API
   reports the hole honestly. Gap re-requests use exponential backoff with
   a breaker: after the threshold, the stream is marked `gapped` and
   surfaced ONCE (No Unbounded Loops — this is the #863 kill-request-loop
   shape, pre-empted; the sustained-failure test in §6 drives a permanently
   gapped peer and asserts bounded attempts).
5. **The advert rides the existing 30s presence pull's RESPONSE; deltas
   ride separate requests.** Grounded correction: there is no cadenced
   capacity PUSH-heartbeat in the mesh today — the one cadenced exchange is
   `PeerPresencePuller.pullOnce()` sending `session-status` every 30s and
   reading the response. So: the `session-status` RESPONSE payload gains
   the tiny own-stream watermark advert (O(kinds) numbers — own streams
   only, NOT a full replicated matrix; the receiver knows what it holds).
   The puller, on seeing a peer advert ahead of what it holds, issues a
   separate `journal-sync` delta request for specific ranges; responses are
   batched and size-capped (`journalSyncMaxBatchBytes`, default 256KB). The
   presence envelope never bloats with entry payloads — the master spec's
   own root-cause list names large JSON.stringify on hot paths.
   Implementation contract, stated: this is NOT a passive ride —
   `PeerPresencePullerDeps` gains a `requestJournalDelta` callback and the
   recorded capacity widens to carry the advert (the current puller narrows
   the response and discards extras); the `session-status` RESPONSE object
   gains an optional `journalAdvert` field, which old peers ignore and old
   pullers never read (verified forward/backward-compatible — the result is
   parsed permissively on both sides). (Symbols: `PeerPresencePuller.pullOnce`,
   the `session-status` dispatcher handler.)
6. **Mixed-version fleets degrade silently-correctly.** An old peer's RBAC
   default-denies the unknown verb at HTTP 403 (it never reaches the
   501-no-handler path). The sender treats BOTH 403 and 501 from a
   journal-sync as "peer lacks the verb": back off that peer's journal
   exchange quietly — no retry storm, no auth-incident, no hostile-peer
   flag.
7. **Pull-first.** A machine asks for what it's missing; unsolicited push is
   bounded to the advert (the secret-sync anti-clobber lesson). No journal
   data ever rides Threadline (agent-to-agent stays a different trust
   domain).

### 3.5 Read API — bounded, honest about trust and time

`GET /coherence/journal?topic=N&kind=topic-placement&machine=M&limit=100&cursor=<opaque>`
→ merged view over own + peer streams:

```jsonc
{
  "entries": [ { ...entry, "source": "own"|"replica", "recvTs": "…" } ],
  "streams": { "<machineId>.<kind>": { "incarnation": "…", "lastSeq": 412,
               "lastTs": "…", "source": "own"|"replica",
               "status": "current"|"behind"|"gapped"|"suspect"|"reset",
               "stalenessMs": 5300 } },
  "skippedCorrupt": 0,
  "truncated": false
}
```

- **Auth + caps + param hygiene:** standard Bearer middleware (as every
  non-/health route); `limit` server-capped (≤500). The `machine`/`kind`
  query params are NEVER used to construct a file path — they are matched
  against the enumerated on-disk stream set (a directory listing), so a
  traversal-shaped param simply matches nothing (read-side mirror of the
  write-side sanitization; test in §6). Reads are bounded: streams are read
  newest-first via reverse-chunked tail reads (genuinely O(limit), not
  O(file size)), each query has a total byte ceiling AND scans at most a
  capped number of archive files — beyond either bound it returns partial +
  `truncated: true` rather than scanning weeks of history on a
  possibly-starved box ("no scans" in §4.5 is scoped to the
  write/replication path; the read path's rule is "bounded reads with
  honest truncation").
- **Ordering & time honesty:** `seq` is per-stream; the merged view cannot
  be totally ordered by wall-clock (`ts` skews across machines — a 4s clock
  offset would show a topic placed on B before A released it, a phantom
  split-brain in the one tool meant to diagnose real ones). For
  `topic-placement`, the merged order key is **`(epoch, ts)`** — epochs are
  monotonic per topic across machines by the CAS design. Other kinds order
  by `(ts, machineId, seq)` with the tiebreak explicit. Every replicated
  entry carries `recvTs` (when THIS machine learned it) so consumers can
  distinguish "when it happened (skewable)" from "when it arrived". An
  entry whose `ts` is implausible vs. receipt time (> tolerance future, or
  regressing on the same topic) is flagged, not silently merged.
- **Pagination:** `cursor` is an opaque composite keyset cursor encoding
  THE QUERY'S ORDER KEY — `(epoch, ts, machineId, seq)` for
  `topic-placement`, `(ts, machineId, seq)` for other kinds (a cursor over
  a different key than the sort order would skip/duplicate at boundaries).
  Raw `before=<seq>` is meaningless across a merged multi-stream view and
  is only accepted together with a single `machine=` + `kind=` filter.
- **Placement queries are ANSWER-COMPLETE:** for the rotate-never-delete
  kind, a `topic=N&kind=topic-placement` query does not stop at the
  generic archive-file cap — placement archives are tiny, and the query
  scans them newest-first until `limit` is satisfied for that topic or all
  placement archives are read (the per-query byte ceiling remains the hard
  bound, with `truncated: true` honesty if ever hit). Without this
  exemption, "history kept forever" would be retained on disk yet
  structurally unreachable through the only documented query path once
  archives outgrow the generic cap.
- **Tolerant readers everywhere:** route AND direct-file readers parse
  line-by-line, skip-and-count corrupt lines (`skippedCorrupt` in the
  response) — corruption mid-file (a torn write later buried by good
  appends) must degrade a query, never kill it. Truncate-on-open only
  repairs the writer's own trailing line; interior corruption is the
  reader's job to survive.
- **Degradation rule (master spec §6.4):** the journal is plain JSONL on
  disk — the CLI/hooks may read the files directly when HTTP is starved
  (filesystem permissions are the access control there; acceptable for a
  single-operator local agent and stated as the assumption); the route is a
  convenience, not the only door.

### 3.6 Registry JSON + CI lint (the P0 enforcement, shipping here)

- `src/data/state-coherence-registry.json` — machine form of the approved
  registry doc (category → axes → transport). AUTHORED, not build-generated
  (the committed-generated-manifest conflict-loop lesson — nothing
  regenerates this file at build time). The journal registers itself as its
  first entry.
- `scripts/lint-state-registry.js` — sweeps `src/` for durable-write
  patterns (writeFileSync/appendFileSync/JSONL append/SQLite open targeting
  state dirs); fails CI when a store has no registry entry. Modeled on
  `lint-no-unfunneled-topic-creation.js` — and like it, **appended to the
  `lint` chain in `package.json`** (the only thing that makes it actually
  run in CI + Husky; an unchained lint ships dead). Full-tree mode (like
  the topic-creation lint), not staged-only. HONEST FRAMING: the lint is a
  guardrail, not complete enforcement — durable writes can hide behind
  wrappers, libraries, and dynamic paths; the declared duty remains "a new
  store registers itself," and the lint catches the common direct
  patterns. False-positive ergonomics: an inline
  `/* state-registry: <category> */` annotation satisfies the lint at a
  write site whose store IS registered but whose path is dynamic
  (annotation names the registry entry — greppable, reviewable), so the
  lint stays quiet on legitimate wrappers without a global suppression.
  The registry JSON and the lint land in the SAME PR (P1.1) so
  the lint never sees a missing data file.
  Existing ~100 categories are seeded from the census so the lint lands
  green, with `grandfathered: true` markers where the census was uncertain
  (§4e of the registry doc).

### 3.7 Config, retention & rollout

`.instar/config.json` → `multiMachine.coherenceJournal`:

```jsonc
{
  // "enabled" deliberately OMITTED from ConfigDefaults — the runtime
  // resolves `enabled ?? !!developmentAgent` (the dark-ship pattern,
  // mirroring selfKnowledge.sessionContext). Dark on the fleet, live on
  // echo.
  "replication": { "maxBatchBytes": 262144 },   // enabled follows the same gate
  "retention": {
    // rotateKeep semantics: N>0 = rotate at maxFileBytes, keep N archives,
    // DELETE older. 0 = rotate at maxFileBytes but NEVER delete archives —
    // files stay bounded (the read path's file-count cap + byte ceiling
    // engage normally), history is genuinely forever. "Never rotate" is
    // deliberately NOT expressible: an uncapped live file would make the
    // most-queried stream the most expensive read on a box with a
    // documented starvation history.
    "topic-placement":   { "maxFileBytes": 8388608,  "rotateKeep": 0 },  // bounded files, archives kept forever
    "session-lifecycle": { "maxFileBytes": 16777216, "rotateKeep": 4 },
    "autonomous-run":    { "maxFileBytes": 8388608,  "rotateKeep": 8 }
  },
  "flushIntervalMs": 250
}
```

- Per-kind retention is the answer to old Open Question 1: placement
  history is kept forever in BOUNDED FILES with UNBOUNDED TOTAL RETENTION
  (rotate-but-never-delete, above) — stated plainly: per-file size is
  bounded, total placement disk grows for the agent's lifetime, at the
  rate of ownership changes (tiny, low-frequency). A degradation threshold
  watches archive count + total bytes so growth is observed, not
  discovered. High-volume kinds rotate with deletion. Watermarks
  survive rotation (seq continues across files; sync serves from archive
  when a peer is behind; the rotated-out case is §3.4 rule 4 — for
  placement with `rotateKeep: 0` nothing is ever rotated OUT, so a
  far-behind peer can always be served).
- Single-machine agents: writer on (cheap, locally useful), replication
  no-op (no peers — verified clean no-op in tests).
- **Rollback (§3.8 of the review):** disabling the flag makes writer +
  replication no-ops; existing JSONL files are left on disk, inert and
  still directly readable (consistent with the degradation rule). The CI
  lint is code-level and INDEPENDENT of the runtime flag — it stays green
  as long as the registry JSON exists, so a revert must remove lint + JSON
  together or neither. Journal files live under `state/` and ride any
  state-dir backup; peer replicas are reconstructable and need no backup.

### 3.8 Migration Parity + Agent Awareness (deliverables, same PRs)

- **Config:** add `multiMachine.coherenceJournal` (WITHOUT `enabled`, per
  the dark-ship pattern) to `src/config/ConfigDefaults.ts`;
  `migrateConfig()`'s `applyDefaults` add-missing semantics backfills
  existing agents on update. No "v0.2 backfill later" — same PR as the
  feature (P1.1).
- **CLAUDE.md template (Agent Awareness):** `generateClaudeMd()` gains a
  Capabilities entry for `GET /coherence/journal` with a curl example, a
  "Registry First" row ("which machine was topic N on / where are its
  artifacts?" → this route), and the proactive triggers from §1 (modeled on
  the Reap-log entry — the established read-only "where did X go?"
  pattern). Plus the `migrateClaudeMd()` content-sniffing entry so existing
  agents' CLAUDE.md picks it up. Ships with the route (P1.2). An agent that
  doesn't know the journal exists effectively doesn't have it — the EXO
  stranding would simply recur with the answer sitting unread on disk.
- **No new hooks; no skill content changes** — nothing else in the
  migration matrix is touched.

### 3.9 Signal, never authority (structural ban on actuation)

The journal is observational. That sentence is willpower; this section is
the structure:

- **No actuating code path (kill / spawn / place / transfer / reap) may
  consume journal data.** Replicated state is by construction stale
  (heartbeat-cadenced); a reaper that trusted a replica's "session closed"
  could kill or double-place against reality — the journal would CAUSE the
  duplicate-session incidents it was built to diagnose. Authority for
  actions remains the live single-writer stores (the lease/CAS, the session
  registry).
- Enforced, not asked: a wiring-integrity test asserts no actuator module
  imports the journal reader, and the read API's `source`/`stalenessMs`
  fields exist so any FUTURE consumer must consciously handle staleness.
  P2's working-set pull is re-scoped accordingly: the journal's
  `artifactPaths` *nominate* fetch targets; the actual pull is gated on a
  live peer-HTTP existence check, never a blind trust of replicated paths.

## 4. Degradation requirements (inherited, master spec §6 — restated as behaviors)

1. `journal-sync` acks only after the RECEIVER's append fsyncs
   (ack-after-durable-commit — durability lives on the replication path,
   not the author's hot path; see §3.1).
2. Crash mid-append → truncated partial line repaired on next open; seq
   resumes correctly (kill -9 test); every actual repair is counted +
   surfaced once (Distrust Temporary Success).
3. Every verb idempotent under redelivery (seq-gated, incarnation-fenced
   appends) AND every emit idempotent under operation retry (operation
   keys, §3.1).
4. Journal files readable without the server (plain JSONL; no lock needed
   for readers; readers are per-line tolerant, §3.5).
5. Cheap: emits are non-blocking memory ops + batched background appends;
   replication is delta-only, batch-capped, heartbeat-cadenced, first-hop
   only. No scans on the write/replication path; bounded scans with honest
   truncation on the read path (§3.5).

## 5. Security

Master spec §8 applies, sharpened by convergence:

- **Metadata-only by typed schema** (§3.1) — the redaction enum is a
  secondary pass, not the boundary.
- **Transport:** machineAuth-only; registered-peer RBAC; nonce-replay and
  recipient-binding inherited from MeshRpc.
- **Application-layer trust:** first-hop-only + per-entry sender binding +
  schema-validated apply + incarnation fencing (§3.4) — transport auth
  alone does not make in-payload claims authentic, so the payload rules
  force authorship = sender in P1.
- **At-rest honesty:** entries are unsigned at rest in P1; replicas are
  therefore trusted only as far as the local filesystem. That is acceptable
  ONLY because of §3.9 (nothing actuates off the journal) and is stated in
  the read API (`source: replica`). Per-entry signatures are the named
  upgrade path if any future phase needs transitive relay or
  tamper-evident audit.
- **Write surface on standbys:** the dedicated `journalScoped` guard
  exception is canonicalized-prefix-exact (§3.1); peer-file appends go only
  through the validated sync handler — the actual invariant is "single
  PRODUCER per stream (origin machine), single local APPLIER per replica
  (the sync handler), no other writer," and a test enforces it.

## 6. Testing (all three tiers + degradation + the independent oracle)

- **Unit:** writer (monotonic seq assigned-at-enqueue + resume-from-tail,
  append-only, crash-repair on open + repair-counted + repair-is-not-reset,
  rotation continuity per kind incl. rotate-never-delete for placement,
  typed-schema rejection of free-text/unknown fields/secret-shaped fields,
  artifactPath jail [traversal/absolute/symlink cases], operation-key
  dedupe SURVIVING a writer restart [tail-reconstruction], rate cap,
  single-process lock contention [two writers, no torn lines / no forked
  seq], NON-BLOCKING emit under a wedged flusher [fault-injection]);
  watermark advert merge; seq-gated + incarnation-fenced apply (gap hold w/
  backoff+breaker, duplicate drop, NEW-incarnation quarantine-and-signal,
  re-mint trigger precision [kill-9 repair does NOT re-mint; genuine
  rewind below highWaterSeq DOES], incarnation-flap bound [repeated flips →
  bounded disk + coalesced signals + reset-flapping], `suspect`
  self-clearing after K clean applies, truncation fast-forward w/ gap
  sentinel); mixed-version 403/501 back-off.
- **Integration:** two in-process journals round-trip `journal-sync` deltas
  through the real MeshRpc envelope; forged third-machine entries rejected;
  malformed entries mark stream suspect without poisoning the merged view;
  `GET /coherence/journal` merged view + filters + cursor + caps +
  `skippedCorrupt` + traversal-shaped `machine`/`kind` params match nothing
  + `(topic, epoch)` placement collapse; standby-write permitted via
  `guardJournalWrite` with the pool INACTIVE (the quiet-standby case) and
  blocked outside the prefix; registry lint green on the seeded registry
  and red on an undeclared synthetic store; the autonomous journal scanner
  emits started / observed-stopped across a simulated run lifecycle.
- **E2E:** production-init boots writer + route alive (200-not-503); a
  simulated place→transfer→close sequence yields the correct placement
  history from BOTH machines' read APIs; kill -9 mid-append → clean resume
  (degradation tier); P19 sustained-failure test (permanently-gapped peer →
  bounded re-requests, breaker fires once).
- **Wiring-integrity (with INDEPENDENT oracles — the journal never verifies
  itself):** drive place/transfer/release/failover and assert the journal
  lines against the CAS's returned epochs read from the ownership store
  directly; drive each lifecycle transition and cross-check against the
  reap-log line / session registry status; drive autonomous start/stop and
  cross-check against the `.local.md` files on disk. A lint asserts no
  ownership-store write exists outside the CAS funnel, and no actuator
  imports the journal reader (§3.9). Self-emission exclusion: a full sync
  round produces zero new journal entries.

## 7. Work breakdown (P1.1 → P1.3, one PR each unless trivially small)

1. **P1.1** `CoherenceJournal` writer (non-blocking enqueue-assigned seq +
   flusher + lock + schemas + jail + restart-proof dedupe) +
   `recordLifecycle` funnel + `emitPlacement` wrapper at the CAS call
   sites + the autonomous journal scanner + `StateManager.guardJournalWrite`
   + registry JSON + CI lint (chained in `lint`) + ConfigDefaults +
   migrateConfig + unit tests.
2. **P1.2** `GET /coherence/journal` (bounded reverse-tail reads, opaque
   cursor, source/staleness honesty, epoch-collapse, param hygiene) +
   CLAUDE.md template entries + migrateClaudeMd + integration tests.
3. **P1.3** `journal-sync` verb (advert on the `session-status` response,
   separate delta requests, validated apply with suspect self-clearing,
   incarnation fencing w/ highWaterSeq + flap bounds, truncation signals,
   mixed-version backoff) + E2E across two in-process servers + live
   two-machine verification (Laptop+Mini: move a topic, read its history
   from both sides).

## 8. Open questions for Justin

1. ~~Retention horizon~~ — RESOLVED in convergence: per-kind retention;
   placement effectively forever (tiny), high-volume kinds rotate (§3.7).
2. **Live verification scope for P1.3** — the real two-machine proof
   (move topic, read history from both machines) — fine to run it on your
   live fleet as the closing step, as we did for the pool features?
