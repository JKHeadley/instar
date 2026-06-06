---
title: "Commitments Coherence — one logical promise list across machines (P1.5 of multi-machine coherence)"
slug: "commitments-coherence"
author: "echo"
eli16-overview: "COMMITMENTS-COHERENCE-SPEC.eli16.md"
status: "converged-approved"
approved: true
approved-by: "justin (standing directive)"
approved-evidence: "Topic 13481, 2026-06-06 ~03:05 PDT: 'Yes, please enter a 24 hour autonomy session and continue to proceed through each project step making sure you implement each one and tested extremely thoroughly' — covers per-step convergence, build, all-tier testing, live verify on the echo pair. ELI16 sent to topic 13481 at approval."
layer: "core-instar-primitive"
parent-principle: "Structure beats Willpower — a promise made on one machine is visible and close-requestable from every machine by machinery, not by anyone remembering where it was made"
parent-spec: "MULTI-MACHINE-COHERENCE-MASTER-SPEC.md"
project: "multimachine-coherence"
project-items: "P1.5 commitments-replication, P1.5 owner-routed-mutation"
supervision: "tier0 — deterministic delta replication + owner-routed CAS mutation forwarding; no policy decisions. Justified per LLM-Supervised Execution."
lessons-engaged: >
  P3 (store-shape migration: replicationSeq is an ADDITIVE store field, never
  a schema-version bump — the loadStore acceptance guard is untouched; legacy
  seed forces one full re-pull); P19 (every repeating behavior bounded: the
  snapshot drive rides the presence cadence, the online forward is
  single-attempt + timeout-to-queue, the pending re-fire is attempt-capped
  with busy exempt); B24 (gate latency: forward timeout = ambiguous outcome →
  durable queue with the SAME opKey, idempotent by construction); Deferral =
  Deletion (the beacon-transfer deferral is registered against the
  multimachine-coherence P3 round item, not a private intention); Signal vs
  Authority (replicas and merged views never actuate; the owner's CAS state
  machine is the only authority).
inherited-invariants: >
  This spec INHERITS the converged P1 invariants by reference
  (COHERENCE-JOURNAL-SPEC) and the P2 additions (WORKING-SET-HANDOFF-SPEC):
  no synchronous I/O in hot paths; first-hop-only trust; bounded
  loops/backoff/breaker on every repeating behavior; ack-after-durable-commit;
  observability never endangers the observed operation; replicated data is
  SIGNAL, never actuation authority; operation-keyed idempotency surviving
  restarts; single-writer discipline on every shared mutable store; busy is
  retry-without-penalty; durable pending-work records for offline peers;
  incarnation fencing on every replicated stream (a restored store must never
  silently strand replication). Reviewers: treat violations of these as
  material without re-deriving them.
review-convergence: "2026-06-06T12:08:41.792Z"
review-iterations: 3
review-completed-at: "2026-06-06T12:08:41.792Z"
review-report: "docs/specs/reports/commitments-coherence-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
---

# Commitments Coherence (P1.5)

> **One sentence:** a commitment opened on any machine is VISIBLE from every
> machine and CLOSE-REQUESTABLE from every machine — reads merge first-hop
> replicas; writes route to the single machine that owns the record and are
> APPLIED BY THE OWNER WHEN REACHABLE, with a durable queue and an honest
> "queued" answer when it is not — so "what did you promise me?" and "mark it
> delivered" stop depending on which laptop the user happens to be talking to.

## 1. Motivation (master spec §10.1, Justin-approved P1.5)

The CommitmentTracker store (`state/commitments.json`) is machine-local.
PromiseBeacon, the overdue surfacing, and `/commitments/*` see only the
local file. On a two-machine agent this breaks the core contract in both
directions: reads under-report obligations; closes fail on the
wrong machine. P1 made history flow; P2 made files flow; P1.5 makes
PROMISES flow.

The conflict-shape insight that keeps this simple: a commitment is created
by exactly ONE machine and carries a per-record CAS `version` — the store
is already single-writer per record. Replicating reads and ROUTING writes
to the owner preserves that single-writer discipline fleet-wide, with zero
merge logic invented.

**Why not event-sourcing (the master spec's "append-only-mergeable" hint):**
commitments are naturally event-shaped, and an opened/delivered/violated
event log per owner with a materialized merge would also work. We chose
snapshot-delta + owner-routing because (a) it leaves a battle-tested store
and its CAS untouched (the event refactor rewrites the store, every
consumer, and the live corpus), (b) owner-routing already gives one logical
list without merge semantics, and (c) the auditability event-sourcing buys
is partially covered by P1's journal. The trade is acknowledged: weaker
replay/audit granularity, and the replication layer must carry its own
incarnation fencing (§3.2) instead of inheriting append-only semantics.
Revisit only if live operation surfaces a real merge need.

## 2. Scope

**In:**
- P1.5a — **read replication**: each machine's own commitments replicate
  first-hop to peers as seq-windowed deltas; the read surfaces merge own +
  replicas with source + staleness honesty.
- P1.5b — **owner-routed mutation**: a state-changing call landing on a
  non-owner machine forwards ONE signed mesh command to the owner; offline
  or older-version owner → a durable pending-mutation record that re-fires
  on the owner's return.

**Out (explicitly):**
- Beacon/actuation transfer — PromiseBeacon heartbeats stay on the OWNING
  machine in P1.5. A beacon whose owner sleeps goes quiet until that
  machine returns; closure still works from anywhere via the queue. This
  deferral is REGISTERED against the multimachine-coherence project's P3
  round item (machine-swap semantics — beacon-duty transfer is a
  machine-swap concern), not a private intention
  <!-- tracked: multimachine-coherence-p3-threadline-registry-machine-swap -->.
  §3.3a names the duplicate-promise consequence this creates and the
  merge-layer signal that surfaces it.
- Event-log refactor of the store itself (§1's why-not paragraph).
- Cross-AGENT commitments (this is one agent's machines, same operator).

## 3. Design

**Glossary:** *owner (of a commitment)* = the machine whose
CommitmentTracker created the record (`originMachineId`, stamped at
creation). *composite key* = `(originMachineId, id)` — THE cross-machine
identity (§3.1). *replica* = a peer's read-only copy of another machine's
records. *first-hop* = a replica is accepted only from the machine that
owns it, never relayed.

### 3.1 Identity — the composite key (corrects a false round-1 premise)

`Commitment.id` is a PER-MACHINE SEQUENTIAL counter (`CMT-001, CMT-002…`,
minted from the local store's max — `CommitmentTracker.computeNextId`).
Two machines WILL mint the same id for different commitments — cross-
machine collisions are the NORMAL case, not a corner. Therefore:

- `Commitment` gains `originMachineId?: string`, stamped at creation from
  the server's mesh identity (the journal's `cjOwnMachineId`; hostname
  fallback). Never reassigned. Legacy records: owned by the store they
  live in — the SERVE side stamps them with its own machine id before
  serving (read-path annotation; the store is also lazily back-filled on
  the record's next mutate).
- **The cross-machine identity is the composite `(originMachineId, id)`
  EVERYWHERE**: the merge dedupe, the `commitment-mutate` payload, the
  pending-mutation ledger key, and the owner-routing decision. A bare `id`
  NEVER routes across machines.
- `GET /commitments/:id` (and the mutation routes): a bare id that matches
  exactly ONE record in the merged view resolves to it; an ambiguous bare
  id (own + replica collision) returns **409 ambiguous** listing the
  candidates with their `originMachineId` — the caller retries with
  `?origin=<machineId>`. An own-store match is NEVER silently preferred
  (round-1's "own wins" is struck: it masked real obligations).

### 3.2 Read replication — `commitments-sync` (P1.5a)

A read/observe-class MeshCommand, three lockstep edits mirroring
`journal-sync`:

`{ type: 'commitments-sync'; request?: { sinceSeq: number; incarnation?: string } }`

**Store-side bookkeeping (additive, Migration Parity §3.6):**
- **Write-transaction boundary (one file, one atomic write):** record
  mutations, the `replicationSeq` bump, and each record's `lastMutatedSeq`
  stamp all live in the SAME `commitments.json` and persist in ONE
  temp-file + atomic-rename `saveStore()` write — single-file atomicity
  makes a torn seq/record pair impossible by construction. The opKey
  window is a SEPARATE file: written AFTER the store write, ack only
  after both; a crash between the two leaves an applied mutation without
  its opKey record, which the re-issued re-fire resolves through the CAS
  as an `idempotent-noop` verdict — recovered, never double-applied.
- `CommitmentStore` gains `replicationSeq: number` — a monotonic counter
  (deliberately NOT named `version`: the store already has a frozen
  schema-version literal `version: 2` AND a per-record CAS `version`;
  a third "version" would be the confusion Migration Parity exists to
  prevent). Bumped in `saveStore()` for STATE-MEANINGFUL mutations only —
  status transitions, field edits, creation, expiry — and explicitly NOT
  for beacon bookkeeping writes (`consecutiveUnchanged`,
  `lastHeartbeatAt`, `heartbeatCount`): a quiet agent's heartbeats must
  not re-ship snapshots (the write-amplification PromiseBeacon was
  already tuned to avoid). Held in memory after load; the advert NEVER
  reads disk on the presence tick.
- Each record gains `lastMutatedSeq: number` — stamped with the
  replicationSeq of its last state-meaningful mutation. This is what
  makes the sync a DELTA, not a blob.
- `CommitmentStore` gains `storeIncarnation: string` — minted when absent
  (first post-upgrade load) and RE-MINTED whenever a rewind is detected
  (replicationSeq below the persisted high-water in the store's meta
  sidecar — the journal §3.4 rule 3 mechanism verbatim). A restored
  backup therefore changes incarnation instead of silently stranding
  replication behind a peer's higher remembered seq.
- **Legacy stores**: `replicationSeq` seeds to `1` with a fresh
  incarnation — peers hold nothing for that incarnation, so the first
  sync is a full pull by construction (never a 0-meaning-unchanged
  strand). The schema `version: 2` literal is UNTOUCHED — additive
  fields only; the `loadStore` acceptance guard does not change, and a
  DOWNGRADED instar reading the store ignores the unknown fields (a §6
  test asserts both directions).

**Serve side**: answers with records where `lastMutatedSeq > sinceSeq`,
OWN records only (replica rows are NEVER re-served — and §3.3's invariant
means they can't be: replicas never enter the tracker's store). Pages are
capped at the journal-sync 256KB ceiling with `nextSinceSeq` cursors —
ordering is `lastMutatedSeq` ascending with `id` as tiebreaker, the
cursor EXCLUSIVE (`> sinceSeq`); a single record larger than the cap is
served alone in its own page (a page always carries at least one
record). A record mutated DURING a multi-page catch-up jumps to a higher
lastMutatedSeq and arrives on a later page or the next tick — the cursor
model self-heals, nothing is missed. A large store replicates fully over
multiple requests (the P2 chunking lesson; a flat truncating cap would
leave tail commitments PERMANENTLY unreplicated and un-closeable from
peers, which round-1 caught). A
`sinceSeq` request carrying a STALE incarnation is answered
`{ incarnationChanged: true, incarnation, fromSeq: 0 }` — the receiver
discards the replica wholesale and re-pulls from 0.

**Secret posture on served text (widens P1 — stated, not smuggled):** P1's
journal deliberately carried "id + status only, not content"; P1.5 ships
commitment FREE TEXT (`userRequest`, `agentResponse`, `resolution`,
`escalationDetail`) because the merged read is useless without it. Before
serving, the credential-shape scan (the same versioned enum P2 uses) runs
over each record's free-text fields; a flagged FIELD ships REDACTED
(`[redacted:<category>]` placeholder + `textRedacted: true` on the record)
— the record itself (id, status, type, topic) still replicates, so
closeability never depends on the scan. The scan is LEAK-REDUCTION, not
the boundary; the boundary is the same-operator peer posture, re-evaluated
before any non-same-operator peer class exists (the P2 §3.1 tripwire,
restated here because P1.5 has no upstream typed-schema boundary either).

**Drive**: rides the SAME PeerPresencePuller 30s cadence and the SAME
explicit `replication.enabled === true` gate as journal-sync and the
working set. The peer's `session-status` capacity response gains
`commitmentsAdvert?: { incarnation: string; replicationSeq: number }`
(from memory; old peers omit it → no-op). The puller requests deltas only
when the advert is ahead of the replica's stored cursor — and pages until
caught up (bounded per pass: at most `maxSyncPagesPerTick`, default 4,
the remainder rides the next tick).

**Receive side**: delta records are applied into
`state/commitment-replicas/<ownerMachineId>.json` keyed by the composite
key (temp-file + atomic rename; the replica file carries
`{ ownerMachineId, incarnation, sinceSeq, receivedAt, records }`).
**First-hop enforcement with teeth** (round-1: the journal's
`entry.machine === sender` rule needs a field to bind): `ownerMachineId`
is derived from the AUTHENTICATED `env.sender` — never a payload field —
and every record whose `originMachineId !== env.sender` is REJECTED +
counted (`forgedRows`), exactly as JournalSyncApplier.validateEntry
rejects forged entries. A registered peer can therefore not inject rows
attributed to (or routable to) third machines. Corrupt replica file →
quarantine + full re-pull (never silently empty).

### 3.3 The merged read (own + replicas, honest)

A read-side merge layer OUTSIDE CommitmentTracker. **Structural
invariant (test-enforced): replica rows NEVER enter
`CommitmentTracker.store`** — the tracker stays the single-writer engine
for OWN records, which is exactly why PromiseBeacon (which iterates
`commitmentTracker.getActive()`) can never heartbeat another machine's
promise.

- The real read surfaces — `GET /commitments`, `GET /commitments/:id`,
  `GET /commitments/active-context` (round-1 correction: there is no
  "commitment-check job"; these three routes are the actual consumers) —
  merge own records + every replica's records on the composite key. Each
  merged row carries `source: 'own' | 'replica'`, `originMachineId`, and
  `stalenessMs` for replica rows.
- `pendingMutation` is a **COMPUTED merge-time field** — derived by
  joining the live pending-mutation ledger on `(originMachineId, id)` —
  never a stored bit on the replica file (round-1: a stored flag has no
  clearing path when the owner REFUSES a transition — refusal doesn't
  bump the owner's replicationSeq, so no snapshot would ever overwrite
  it; computing it makes it vanish the moment the ledger record resolves,
  refuses, or TTL-expires, and removes a route-layer write into a
  receive-owned file).
- Replica staleness past `replicaStaleWarnMs` (default 10 min) renders an
  honest `(as of <time>, from <machine>)` qualifier in user-facing
  listings.
- **Signal vs Authority**: replica rows are READ-ONLY signal. PromiseBeacon
  iterates OWN records only (by construction, above); overdue ESCALATION
  fires only for own records; the merged view answers questions.

### 3.3a Duplicate logical promises (named, surfaced, not merged)

The beacon-stays-home deferral CREATES a duplicate path: A holds CMT-A for
promise X, A sleeps, its beacon goes quiet, the user re-asks on B, B
creates CMT-B for the same logical promise (creation is always local —
there is deliberately no cross-machine create routing). When A returns,
the merged view holds BOTH, and both machines beacon their own copy.
P1.5's stance:

- **Detect-and-surface, never auto-merge**: the merge layer flags open
  rows sharing `topicId` + `type` whose creation windows overlap as
  `possibleDuplicateOf: [<composite keys>]` — an explicitly HEURISTIC
  soft signal (it will miss rephrased duplicates and overflag busy
  topics; it surfaces the common shape of the problem, it does not solve
  it) that the agent mentions when listing ("these two may be the same promise") and when
  delivering one ("a possible duplicate on <machine> is still open —
  deliver it too?"). Semantic dedupe stays a human/agent decision.
- The double-beacon consequence is an ACCEPTED P1.5 limitation, stated
  here and resolved by the same P3 beacon-transfer item the §2 deferral
  is registered against.

### 3.4 Owner-routed mutation (P1.5b — close-requestable from anywhere)

The REAL mutation routes (round-1 correction — `/violate` and `/cancel`
do not exist): `POST /commitments/:id/deliver`, `/withdraw`, `/resume`,
and the beacon-field `PATCH /commitments/:id`. Owner-routing lives at the
ROUTE layer; CommitmentTracker is untouched:

1. Composite key resolves to an OWN record (or legacy-local) → mutate
   locally, exactly as today.
2. Composite key resolves to a replica → forward ONE signed
   `{ type: 'commitment-mutate'; origin; id; op; args; opKey; requestedAt; callerMachineId; observedStatus }`
   to the owner. Discipline:
   - **Single attempt, bounded** (P19/B24): one send, the MeshRpcClient's
     5s timeout. NO synchronous retry loop inside the user's request. A
     timeout is an AMBIGUOUS outcome (the owner may have applied it) —
     the route files a pending-mutation with the SAME opKey (idempotent:
     if the owner did apply, the re-fire is a no-op verdict) and answers
     honestly: "queued — confirming with <machine>".
   - **The owner applies through verdict-bearing wrappers** around
     `CommitmentTracker.mutate()` (CAS). Round-1 found the existing
     methods collapse outcomes (`deliver()` returns null for both
     already-terminal and not-found); the owner-side apply must return a
     DISTINCT verdict: `applied | idempotent-noop | invalid-transition |
     not-found | version-conflict`. The verdict travels in the HANDLER
     RESULT payload (not the dispatch status — `statusForReason` has no
     application-verdict mappings, correctly).
   - **opKey idempotency, durable on the OWNER**: applied opKeys persist
     in a bounded window (`state/coherence-journal/commitment-opkeys.json`,
     single-writer, atomic) with TTL ≥ the pending-mutation TTL (7d) —
     round-1: the envelope nonce window is only 60s, so this window is
     the ONLY replay control for the apply path, and it must survive an
     owner restart. A replayed/re-fired mutate inside the window returns
     the recorded verdict, applies nothing.
   - **RBAC honesty**: `commitment-mutate` is its OWN case in the RBAC
     switch (default-deny protects it until added). The case admits any
     registered peer — meaning RBAC adds NO authorization beyond
     `verifyEnvelope` (registered peer + signature + recipient binding +
     nonce), WHICH IS THE INTENDED SOLE AUTHORITY, stated so no reviewer
     assumes a role check exists. The owner's state machine re-validates
     every transition (mesh adds reach, not authority); `observedStatus`
     lets the owner annotate a verdict when the caller acted on a stale
     view.
   - **Mutating-verb mixed-version honesty** (round-1: quiet back-off is
     WRONG for a dropped close): an owner answering 403/501 (older
     version, no handler) → the route files the pending-mutation and
     tells the user "queued — <machine> runs an older version; applies
     after it updates". Never a silent back-off, never a fake success.
3. Owner unreachable → the durable pending-mutation record
   (`state/commitment-replicas/pending-mutations.json` — the P2
   PendingPullLedger pattern: serialized mutate() funnel,
   corrupt-quarantine, TTL 7d with ONE agent-health expiry notice,
   re-fired by the SAME onPeerRecorded seam, attempt-capped with busy
   exempt). **Queue-apply trust model (round-1 F4, resolved):** the
   record stores the INTENT (op + args + opKey + requestedAt +
   observedStatus), NOT a signed envelope. At fire time the FORWARDING
   machine re-issues a FRESH signed `commitment-mutate` — so the owner
   always evaluates a live, fully-verified envelope (signature, nonce,
   timestamp all current); the queue is never an unauthenticated apply
   surface, and the stale-timestamp paradox (a 7-day-old envelope can't
   pass a 30s tolerance) never arises. Bounds: at most
   `maxPendingOpsPerCommitment` (default 4) records per
   (origin, id) and `maxPendingOpsPerOwner` (default 64) per owner
   machine — one peer cannot stage an unbounded transition batch.
4. The same commitment mutated from TWO machines while the owner sleeps:
   both queues re-issue on the owner's return; the operations are
   SERIALIZABLE AT THE OWNER (arrival order itself is nondeterministic —
   the CAS guarantees a valid serialization, not a globally predictable
   winner): deliver-after-deliver → `idempotent-noop`; a conflicting
   transition → `invalid-transition`. Every refused/conflicting queued
   operation surfaces its verdict on the forwarding machine (one
   agent-health note naming the op and why) — never a silent loss.

### 3.5 Legacy + mixed-version honesty

- Legacy records: §3.1 (serve-time stamping + lazy back-fill).
- Old peer (no `commitments-sync` handler): 403/501 → quiet back-off for
  the READ path (absence, never fabrication). For the MUTATE path: §3.4
  rule 2 (queue + honest user answer — a dropped close is never quiet).
- Single-machine agents: no peers → merge returns own records unchanged;
  routes behave byte-identically to today.

### 3.6 Config & rollout

No new enable flag: rides
`multiMachine.coherenceJournal.replication.enabled === true` (one
coherence-replication gate — journal, working set, commitments move
together). The MUTATING verb's distinct exposure is gated at the RBAC
case + the handler registration, both of which only matter when the gate
constructs the layer. Tunables under
`multiMachine.coherenceJournal.commitments`:
`{ syncPageBytes: 262144, maxSyncPagesPerTick: 4, replicaStaleWarnMs: 600000, pendingMutationTtlDays: 7, maxPendingOpsPerCommitment: 4, maxPendingOpsPerOwner: 64, opKeyTtlDays: 7 }`
(types.ts + ConfigDefaults literal, Migration Parity).

State-Coherence Registry: NEW categories `commitment-replicas`
(derived-cache, single-writer: the receive path), `commitment-pending-
mutations` (machine-local, single-writer funnel), `commitment-opkeys`
(machine-local, single-writer). The EXISTING `commitments` category's
DESCRIPTION text (there is no `fulfilled-by` field in the registry
schema — round-1 correction) updates to note owner-routing fulfills its
peer-http transport and that the census's "AO desired" annotation is
resolved-as-won't-do (owner-routing achieves coherence without the
append-only conversion).

CLAUDE.md template + migrateClaudeMd: the commitments section gains the
cross-machine sentence ("a commitment opened on any of my machines is
visible from all of them and close-REQUESTABLE from all of them; closing
one whose home machine is asleep queues durably, answers honestly, and
applies on its return").

## 4. Degradation requirements (inherited, plus)

1. Replication failure NEVER affects local commitment operation.
2. A pending-mutation is never silently dropped: applied,
   refused-with-verdict, or TTL-expired with ONE agent-health notice —
   and the merge-time `pendingMutation` field vanishes with the record
   (no orphaned flags by construction).
3. Delta serve is paged (256KB/page, bounded pages per tick); the advert
   is answered from memory; an unchanged store costs one integer compare.
4. Mixed-version: read → quiet back-off; mutate → queue + honest answer.
5. kill -9 mid-replica-write → temp-file + rename leaves the previous
   replica intact. kill -9 on the owner between apply and opKey persist →
   the opKey write happens INSIDE the same mutate() funnel transaction
   boundary as the verdict (write-ordered before the ack), so a re-fire
   after the crash re-applies idempotently through the CAS at worst.
6. Incarnation change → wholesale replica replacement, never a
   sinceSeq-short-circuit against a restored store.

## 5. Security

- FIRST-HOP with teeth: replica identity = authenticated `env.sender`;
  rows claiming `originMachineId !== sender` rejected + counted (§3.2).
- `commitment-mutate`: verifyEnvelope is the SOLE authority (stated);
  owner re-validates every transition; durable opKey window (TTL ≥
  pending TTL) is the replay control beyond the 60s nonce window;
  re-issued-fresh-envelope queue model (§3.4 rule 3) keeps the durable
  queue off the trust path; per-(origin,id) and per-owner enqueue bounds.
- Disclosure widening from P1 acknowledged: full commitment text
  replicates, credential-shape-scanned per field with redacted-field
  shipping (closeability never depends on the scan); same-operator
  posture is the boundary, re-evaluated before any non-same-operator
  peer class (§3.2).
- No deletion path; replicas overwritten/advanced atomically.

## 6. Testing (all three tiers + independent oracles)

- **Unit:** composite-key identity (cross-machine id collision: two
  CMT-007s merge as TWO rows; bare-id 409 ambiguity + ?origin
  resolution); origin stamping + serve-time legacy stamping + lazy
  back-fill; replicationSeq bumps on state mutations and NOT on beacon
  bookkeeping; incarnation re-mint on rewind + receiver wholesale
  replacement; delta paging (multi-page catch-up, nextSinceSeq cursors,
  per-tick page bound); forged-row rejection (originMachineId ≠ sender);
  text-field redaction ships the record with textRedacted; merge layer
  (source/staleness tags, computed pendingMutation appears with a ledger
  record and vanishes on refusal/TTL — the phantom-flag case;
  possibleDuplicateOf flags overlapping same-topic open rows; replica
  rows never enter CommitmentTracker.store — the structural invariant
  test; PromiseBeacon iteration never sees replicas); owner-routing
  decision matrix (own → local, replica → forward, ambiguous → 409,
  absent → 404); verdict-bearing wrappers (applied / idempotent-noop /
  invalid-transition / not-found distinct); opKey window (replayed
  mutate returns recorded verdict; survives owner restart); pending
  ledger (re-issue-fresh-envelope at fire time, enqueue bounds, TTL
  notice once, concurrent mutate drops no record, corrupt quarantine);
  legacy store load (replicationSeq seeded + incarnation minted;
  downgrade reader tolerates the new fields).
- **Integration:** full `commitments-sync` paged round-trip through the
  REAL express + signed MeshRpcClient path (multi-page store);
  `commitment-mutate` forward applied through the owner's REAL
  CommitmentTracker (verdict in handler result); timeout-ambiguity →
  pending-mutation with same opKey → re-fire returns idempotent-noop;
  old-peer 501 on mutate → queued + honest answer; merged
  GET /commitments over real own+replica files; 409 ambiguity through
  the real route.
- **E2E (production-shaped, feature-alive 200-not-503):** machine A opens
  a commitment → B's merged view shows it (replica, staleness-tagged) →
  "deliver" issued ON B → A's store transitions (verified by reading A's
  commitments.json directly — the independent oracle) → B's replica
  converges on the next sync. THE OFFLINE CASE: A asleep → deliver on B
  queues durably → survives B's restart → A returns → fresh envelope
  re-issued → applied → both views converge → the computed
  pendingMutation field vanishes.
- **Wiring-integrity:** the merge layer is reachable from the real
  routes; the puller drive fires the delta request when the advert is
  ahead (observed via files); the boot path constructs the layer under
  the gate (alive = 200, dark = 503).

## 7. Work breakdown

1. **P1.5a** store bookkeeping (replicationSeq + lastMutatedSeq +
   storeIncarnation + origin stamping) + `commitments-sync` verb (three
   lockstep edits) + paged serve/receive + merge layer + unit/integration.
2. **P1.5b** owner-routed mutation + verdict wrappers +
   `commitment-mutate` verb + opKey window + pending-mutation ledger +
   route wiring + duplicate-surface + CLAUDE.md template + migrateClaudeMd
   + e2e + live two-machine verify on the echo pair (open a commitment on
   the Laptop, read AND deliver it from the Mini, show the Laptop's store
   transitioned; then the offline case with the Laptop's server stopped).

## 8. Open questions for Justin

1. ~~Beacon-ownership transfer when a topic moves~~ — DEFERRED by design
   (§2 Out, registered against the P3 round item): heartbeats stay with
   the owning machine; closure works from anywhere via owner-routing +
   the durable queue; duplicates are surfaced (§3.3a), not auto-merged.
