---
title: "Multi-Machine Replicated-Store Foundation — HLC + snapshot-then-tail + quarantine ring + union-reader (the WS2 substrate)"
slug: "multi-machine-replicated-store-foundation"
author: "echo"
eli16-overview: "multi-machine-replicated-store-foundation.eli16.md"
status: "converged"
review-convergence: "2026-06-13T06:18:57.000Z"
review-iterations: 2
review-completed-at: "2026-06-13T06:18:57.000Z"
approved: true
approved-by: "operator pre-approval — Justin, topic 13481, 2026-06-12: full session pre-approval for this initiative's decisions (exercised by Echo in the pre-approved autonomous run; operator may revoke)"
layer: "core-instar-primitive"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions. A replicated record reaches every machine, but a replicated record NEVER clobbers a divergent local truth: reach is not authority."
parent-spec: "MULTI-MACHINE-SEAMLESSNESS-SPEC.md"
depends-on: "COHERENCE-JOURNAL-SPEC.md (P1.1-P1.3 — the append-only per-machine transport this spec layers store-semantics on top of)"
satisfies-gate: "MULTI-MACHINE-SEAMLESSNESS-SPEC.md Workstream 2 normative mechanics + the WS2.3 deferral plan front-matter ('own security convergence round before the WS2.3 store ships; boundary fixed in this spec'). WS2.x store code is BLOCKED until the HLC + snapshot-then-tail primitives defined here exist."
project: "multimachine-coherence"
supervision: "tier0 — every operation in this foundation is deterministic mechanism (clock arithmetic, schema validation, byte-bounded file reads, set arithmetic for union/un-merge). There is no judgment call to wrap. The ONE place judgment enters (operator conflict resolution) is explicitly delegated UP to the operator via append-both-and-flag + POST /state/resolve-conflict, never decided here. Justified per LLM-Supervised Execution."
lessons-engaged: >
  Engaged: Structure>Willpower (the union-reader is wired at the LOWEST store primitive so no
  caller can bypass it — enforced by a wiring-integrity test, not a code-review reminder);
  Signal vs Authority (this foundation is MECHANISM — it orders, validates, quarantines, and
  unions; it NEVER actuates and NEVER decides a conflict winner — §11); Migration Parity
  (every flag via migrateConfig() existence-check; seamlessnessFlags additive advert;
  generateClaudeMd()+migrateClaudeMd() — §10); Agent Awareness (§10); LLM-Supervised Execution
  (tier0 declared); Distrust Temporary Success (the snapshot carries a per-(origin,kind)
  seq-watermark VECTOR riding the EXISTING seq-contiguous transport — no-gap/no-double-apply falls
  out of the applier's seq===lastHeldSeq+1 contiguity, not a scalar HLC filter; a stale-seq tail
  past the tombstone horizon is forced to a full snapshot re-join, never silently trusted — §6);
  No Unbounded Loops (quarantine ring bounded + coalesced; aggregate journal budget; snapshot-build
  breaker; per-peer sustained-failure breaker; snapshot-cache fixed ceiling — §5/§8); instar#1069
  (snapshot build + tail replay run OFF the event loop in a worker, chunked, bounded batches —
  applied at design time, mirroring CartographerSweepEngine); per-entry-files-vs-shared-JSONL
  (#827 — replicated kinds reuse the journal's per-machine-per-kind stream layout); ack-after-
  durable-commit (a replicated record is `applied` only after fdatasync, inherited from
  JournalSyncApplier §4.1).
  Declined: a true CRDT merge engine (over-engineered for the personal-pool scale; append-both-
  and-flag + operator resolution is the deliberate, auditable substitute the master spec already
  resolved — §5/decision 2).
---

# Multi-Machine Replicated-Store Foundation (WS2 substrate)

> **One sentence:** the coherence journal already moves bytes between machines
> append-only and authenticated; THIS spec defines the *store semantics* on top
> of it — a **Hybrid Logical Clock** for total causal ordering across stores, a
> **journal-kind-per-store** emission discipline gated per store, a
> **snapshot-then-tail** join/recover path so a returning machine never replays
> from genesis, a **bounded quarantine ring** for bad records, **union-reader**
> reads that never let a replicated record clobber a divergent local one
> (append-both-and-flag for high-impact stores), **origin-tagged** records with a
> deterministic **rollback-unmerge**, and an **aggregate journal budget** so one
> chatty store cannot starve the rest. It is pure mechanism — it orders,
> validates, quarantines, and unions; it never actuates and never picks a
> conflict winner.

## 1. Motivation (inherited from the master spec)

`MULTI-MACHINE-SEAMLESSNESS-SPEC.md` Workstream 2 ("One memory — the agent's
mind follows the user") requires that six stores replicate across the pool:
preferences+corrections (WS2.1), learnings/semantic memory (WS2.2),
relationships+user registry (WS2.3), knowledge base (WS2.4), evolution queue
(WS2.5), playbook items (WS2.6). The master spec's WS2 "Normative mechanics"
block names primitives that DO NOT YET EXIST in `src/core`
(grep-verified 2026-06-12: no `HybridLogicalClock`, no `ReplicatedStore`, no
`snapshot-then-tail`). The WS2.3 deferral in the master front-matter is explicit:
*"own security convergence round before the WS2.3 store ships; boundary
(encrypted transit, receiver revalidation, origin-tagged rollback) fixed in this
spec."* WS2.x store code is therefore **BLOCKED** until the substrate this
document defines exists. This spec IS that substrate.

This is a FOUNDATION spec: it builds buildable primitives, not a store. WS2.1 /
WS2.3 / etc. each layer their store-specific schema, merge-impact tier, and
config flag ON TOP of these primitives in their own PRs.

## 2. What already exists (the transport — do not reinvent)

Grounded in the real code (read 2026-06-12):

- **`src/core/CoherenceJournal.ts`** — the per-machine, per-kind append-only
  writer. An entry is `{ seq, ts, machine, kind, topic?, data }` (one JSON line).
  `emit()` is NON-BLOCKING (validate + enqueue + return in microseconds; a 250ms
  background flusher does single-line `O_APPEND` writes + batched `fdatasync`).
  `seq` is a per-(machine,kind) monotonic counter; `meta.highWaterSeq` is advanced
  via atomic temp-rename only AFTER data fdatasync (`durable_tail >= highWaterSeq`
  always holds). Kinds are a closed union (`JournalKind`); each kind has a typed
  schema (`validate()`) that DROPS unknown fields and rejects free text, a
  per-kind retention (`DEFAULT_RETENTION`: maxFileBytes + rotateKeep), and a
  per-kind token-bucket rate cap (`DEFAULT_RATE_CAP`). An `incarnation` token
  (re-minted on a genuine rewind) fences stream identity. Degradation is fully
  counted (`JournalDegradation`).
- **`src/core/CoherenceJournalReader.ts`** — the bounded, merged READ path.
  Reverse-tail reads (O(limit), byte-ceilinged, archive-capped), keyset cursor,
  merged ordering across own + replica streams. **Deliberately separate from the
  writer** because §3.9's actuation-ban lint targets imports of this module — no
  actuating code may consume journal data. It already produces a `source:
  'own'|'replica'` tag and a merged view.
- **`src/core/JournalSyncApplier.ts`** — the RECEIVE side. `apply(senderMachineId,
  batch)` enforces seven trust rules: (1) FIRST-HOP SENDER BINDING — every entry's
  `machine` must `===` the authenticated sender; the target file derives from the
  sender, never a payload field. (2) SCHEMA-VALIDATED APPLY — per entry: parseable
  + size-cap + `seq === lastHeldSeq+1` (strict contiguity) + ts parses + typed-data
  schema; ANY failure marks the stream `suspect` and STOPS the batch. (3)
  INCARNATION FENCING — a known stream arriving with a NEW incarnation quarantines
  the old replica (rename-aside, ≤2 kept), starts fresh, emits a coalesced
  divergence signal (>3 flips/10min → `reset-flapping`). (4) TRUNCATION SIGNAL —
  `oldestRetainedSeq` records a gap sentinel + fast-forward + `gapped` status.
  (5) SERVE — `buildServeBatch(kind, fromSeq, ...)` serves only durably-flushed
  entries from the OWN file. A receive append fdatasyncs BEFORE reporting
  `applied` (ack-after-durable-commit, §4.1). `PeerMeta` holds per-kind
  `{ lastHeldSeq, status, consecutiveValid, gaps }` + `flipsMs` + `resetFlapping`.
- **`src/core/seamlessnessConfig.ts`** — `resolveSeamlessnessConfig()` /
  `validateSeamlessnessInvariants()` / `assertSeamlessnessInvariants()`: the
  pattern for resolving optional `multiMachine.*` knobs to concrete values with
  cross-knob invariants enforced at startup (a bad config is REJECTED, never
  silently degraded). `SEAMLESSNESS_PROTOCOL_VERSION`.
- **`MachineCapacity.seamlessnessFlags`** (`src/core/types.ts:1915`) — a bounded
  fixed-size-boolean summary advertised in the capacity heartbeat (rides the
  authenticated Ed25519 envelope). `ws11DeliverReceive`, `ws12DrainReceive` exist.
  **ABSENT = the peer predates this spec OR the feature is dark = non-participant.**
  Populated in `src/commands/server.ts:12765`.

**The gap this spec fills, precisely:** the journal orders records ONLY by
per-stream `seq` (a within-one-machine-one-kind counter). It has NO cross-store,
cross-machine causal order — `seq` from machine A's preferences stream is
incomparable to `seq` from machine B's relationships stream. The applier replays
from `fromSeq` — a returning machine that fell out of the retention window has NO
bounded re-join path (it would request `fromSeq=0` and the peer can no longer
serve it). And the reader merges, but it has no notion of "the local value
diverges from the replicated one" — it presents both as a flat history, not a
store with a current value per key. HLC, snapshot-then-tail, the quarantine ring,
and the union-reader are exactly those four missing pieces.

## 3. Component 1 — HybridLogicalClock (`src/core/HybridLogicalClock.ts`)

A pure, dependency-injected total-order clock. HLC combines physical wall-clock
time (so order tracks real time and is human-readable) with a logical counter
(so causality survives clock skew and equal-millisecond ties).

### 3.1 Structure

```ts
export interface HlcTimestamp {
  /** Physical time in ms since epoch (the LARGEST seen, not necessarily now). */
  physical: number;
  /** Logical counter — breaks ties at equal physical and advances under skew. */
  logical: number;
  /** Node (machine) id of the clock that STAMPED this timestamp. */
  node: string;
}
```

`node` is the stamping machine's id (the same `machineId` the journal uses) — it
is the tie-breaker of LAST resort and, crucially, the carrier of the
**origin tag** (§7). HLC node-id space is the machine-id space; it is a string,
never a small integer bitfield (Phase C: N machines, not 2 — §9).

### 3.2 The three operations

The clock is constructed with an injected physical-time source and a config:

```ts
new HybridLogicalClock({
  node: machineId,                 // this machine's id
  now: () => Date.now(),           // INJECTED — tests pass a fake clock
  maxDriftMs?: number,             // FIXED bounded-drift ceiling (§3.4). Default
                                   // 5 min, clamped to [60s, 15min]. NOT derived
                                   // from any "measured pool skew" (none exists).
  persist?: { load(): HlcTimestamp | null; save(t: HlcTimestamp): void }, // §3.5
});
```

1. **`tick(): HlcTimestamp`** — called when this machine AUTHORS a record (an
   event/send). `pt = max(now(), last.physical)`. If `pt === last.physical` then
   `logical = last.logical + 1`, else `logical = 0`. Update `last`, persist,
   return `{ physical: pt, logical, node }`. **Monotonicity guarantee:** the
   returned timestamp is strictly greater (by §3.3 order) than every previous
   `tick()` and `receive()` result on this clock — even if the wall clock jumps
   backward, because we never let `physical` regress.

2. **`receive(remote: HlcTimestamp): HlcTimestamp`** — called when this machine
   INGESTS a peer's record (during apply). It first runs the bounded-drift check
   (§3.4); if the remote is clamp-rejected the local clock does NOT advance and
   the caller quarantines the record. Otherwise:
   `pt = max(now(), last.physical, remote.physical)`. Then:
   - if `pt === last.physical === remote.physical`: `logical = max(last.logical,
     remote.logical) + 1`
   - else if `pt === last.physical`: `logical = last.logical + 1`
   - else if `pt === remote.physical`: `logical = remote.logical + 1`
   - else: `logical = 0`
   Update `last`, persist, return. This is the canonical HLC merge (Kulkarni et
   al.): it takes the max of both physical clocks and increments the logical
   counter, so the receiving clock can never go backward and a received record's
   causal position is preserved.

3. **`HybridLogicalClock.compare(a, b): -1 | 0 | 1`** (static, pure) — the TOTAL
   order: compare `physical`, then `logical`, then `node` (lexicographic). Equal
   `(physical, logical, node)` ⇒ the SAME stamp ⇒ `0`. Because `node` is the final
   tie-breaker and node ids are unique, **the order is total** (no two distinct
   records from distinct machines are ever "equal" in sort position) — this is
   what makes a deterministic merge across the pool possible.

### 3.3 Total order + monotonicity (the load-bearing invariant)

`compare` defines a strict total order over all `HlcTimestamp`s. Within one
clock, `tick`/`receive` are strictly increasing under that order regardless of
wall-clock behavior. ACROSS clocks, two records stamped by clocks that have
exchanged at least one message are ordered consistently with causality (happens-
before ⇒ `compare < 0`). This is the property WS2 merges rely on: "merges order
by HLC, never raw wall-clock" (master spec line 229).

### 3.4 Bounded-drift handling (the fast-clock-poisoning defense)

The master spec line 230: *"any incoming record whose timestamp exceeds the
receiver's clock by more than the pool's measured skew bound is flagged
skew-suspicious and quarantined."* `receive()` enforces this BEFORE merging.

**The reference point is POOL-RELATIVE, not the local `now()`.** A slow receiver
must NOT quarantine a legitimately-ahead peer just because the receiver's own clock
lags. The drift check compares `remote.physical` against a pool-relative reference
`R = max(last.physical, poolReference)`, where `poolReference` is the highest
physical-time floor the receiver can justify from durable/observed state (its own
last durable HLC, plus — when available — the observed-pool-median physical time
carried in the capacity heartbeat). Using `max(local durable past, pool reference)`
rather than the bare wall-clock `now()` means a receiver whose own NTP is behind
does not falsely reject ahead-but-honest peers.

- If `remote.physical - R > maxDriftMs` ⇒ return a `SkewRejection`
  (`{ rejected: true, reason: 'skew-ahead', remote, reference: R }`). The clock is
  NOT advanced (a fast peer cannot drag our clock into the future), and the caller
  MUST quarantine the record (§5, failure-class `skew-suspicious`). This is the
  structural answer to "a fast clock must not win every merge" — a wildly-future
  record never enters the order at all.
- If `remote.physical` is at/below `R` (peer's clock is slow / record is old), that
  is NORMAL and accepted — slow records simply sort earlier; they cannot poison the
  order.

**`maxDriftMs` is a FIXED config constant in this foundation (BLOCKER-5).** It is
NOT derived from any "measured pool skew" — no such numeric quantity exists today.
`ClockSkewStatus` (`MachineCapacity.clockSkewStatus`, `types.ts:1851`) is a
3-VALUE CATEGORICAL enum (`'ok' | 'divergence-detected-once' |
'suspect-clock-removed'`), NOT a numeric millisecond skew, and citing it as the
source of a numeric bound is the error this blocker corrects.

- Default **5 minutes** (a generous bound for genuine NTP skew + the journal flush
  window). Configurable via `multiMachine.stateSync.maxDriftMs`, CLAMPED to a
  `[60s, 15min]` floor/ceiling at config resolution (`validateStateSyncInvariants`):
  a too-small bound would start rejecting ordinary NTP jitter; a too-large one
  would defeat the fast-clock defense.
- **Future-work (explicitly named, NOT in this foundation):** automatic derivation
  of `maxDriftMs` from a real measured pool skew requires a NEW measurement
  primitive that does not exist yet — e.g. `max observed |routerReceivedAt −
  selfReportedLastSeen|` across online peers from the capacity heartbeat, with
  hysteresis, clamped to the same `[60s, 15min]` window. Until that primitive ships
  (a follow-on spec), the bound is the fixed constant above. §15-risk-6 tracks this.
- The categorical `ClockSkewStatus` enum is still USED, but for its real purpose:
  a machine in `suspect-clock-removed` is barred from the pool by the existing FSM
  (and §15-risk-6's open question on barring authoring), not as a numeric source.

### 3.5 Serialization + persistence

- **Wire/disk form:** `HlcTimestamp` serializes as a compact 3-field JSON object
  (or the string `"<physical>:<logical>:<node>"` for embedding in a key). It is
  carried on each replicated record as a `hlc` field (§4) — additive, so an old
  peer that ignores it still parses the entry (forward-compat, the journal's
  unknown-field-drop contract).
- **Crash safety:** the clock's `last` is persisted (injected `persist.save`) on
  every advance, written atomically (temp + rename). On boot `persist.load()`
  seeds `last` so a restart cannot rewind the clock below its last durable stamp.
  If load returns null (fresh) the clock starts at `{ physical: now(), logical: 0,
  node }`. Distrust Temporary Success: a loaded `last.physical` AHEAD of `now()`
  by more than `maxDriftMs` (a backward wall-clock jump across a restart) is
  honored as the floor (we trust our own durable past over a regressed wall
  clock), and logged once.

### 3.6 Purity + testability

`HybridLogicalClock` imports nothing but its injected seams. No `fs`, no `Date`
directly (only via `now`), no network. Every operation is a pure function of
`(last, input, now())`. This is the most heavily unit-tested component (§12).

## 4. Component 2 — Journal-kind tagging + flag-gated emission

Each replicated store is a NEW `JournalKind` (the master spec's "journal-kind
discipline", line 265). The foundation extends the journal's kind machinery
WITHOUT changing existing kinds:

- **New replicated kinds** (added by the store PRs, not this one): `pref-record`,
  `relationship-record`, `learning-record`, `kb-manifest`, `evolution-record`,
  `playbook-record`, plus the WS4 ack/claim kinds. This foundation adds the
  GENERIC machinery; the first concrete kind lands with WS2.1.
- **The replicated-record envelope.** A replicated store's journal `data` carries,
  in addition to its store-specific fields: `recordKey` (the store's primary key,
  e.g. a preference id), `hlc` (the `HlcTimestamp` from `clock.tick()` at author
  time), `op` (`'put' | 'delete'`), `origin` (the author machine id — equal to
  `entry.machine`, kept explicit so the reader/un-merge does not have to infer
  it), and `observed` (the single `HlcTimestamp` the author had already merged for
  THIS `recordKey` before writing, or absent if none — the last-writer-witness the
  sound concurrency detector needs, §7.2; one bounded HLC, not a per-key vector).
  The typed schema for each replicated kind validates these the same strict way
  existing kinds are validated (reject free text, drop unknown fields, jail any
  path-shaped field). `observed`, when present, is validated as a well-formed
  `HlcTimestamp`; absent is legal (treated as "no prior witness" ⇒ flag-on-
  conflict, the safe direction).
- **Flag-gated emission (ships dark per store).** Emission of a replicated kind is
  gated behind `multiMachine.stateSync.<store>.enabled` (default false). When off,
  the store NEVER emits its kind (no journal traffic, strict no-op). The reader
  filters by kind, so a kind that is never emitted is simply absent — no special-
  casing. This is what lets each store ship dark INDEPENDENTLY.
- **Flag-coherence gating (master spec §5, line 92).** A replicated kind is
  emitted to a peer ONLY when that peer's `seamlessnessFlags` advertises the
  matching `stateSync.<store>` capability. The journal applier "silently drops
  unknown kinds" (forward-compat) — emitting a new kind to an old peer would be
  silently dropped, the NAMED skew-failure mode. The emission gate consults the
  peer advert (§10) before forwarding a replicated kind. A boot-time pool-flag-
  coherence check surfaces (once) any mixed state.

## 5. Component 3 — Quarantine ring (`src/core/ReplicationQuarantine.ts`)

The applier today fences whole streams (incarnation flip → rename-aside) but has
NO per-record quarantine — a malformed/oversized/skew-suspicious/untrusted-origin
record is rejected and counted, but not inspectable. The master spec (line 239)
requires a BOUNDED quarantine ring. This component adds it WITHOUT weakening the
applier's existing stream-level fencing (they compose: a record that fails
validation is quarantined as a record; a stream whose incarnation flips is still
fenced as a stream).

### 5.1 What gets quarantined

Per master spec line 233-245, every inbound replicated record passes the
receiver-side validation gate BEFORE merge. A record is quarantined (not applied,
not silently dropped) when it is:
- malformed (unparseable, fails the typed schema, missing `hlc`/`recordKey`),
- oversized (over the per-entry byte cap),
- skew-suspicious (HLC `receive()` returned a `SkewRejection`, §3.4),
- untrusted-origin (`entry.machine !== authenticatedSender`, i.e. the applier's
  rule-1 forged-entry case — reach is not authority, master spec line 235; ALSO
  covers a single-origin-snapshot record whose `origin !== serving machine`, §6.1
  — a cross-origin snapshot record is quarantined here, never landed),
- delete-resurrection (a `put` whose `hlc` is below the per-store deleted-keys
  high-water for its `recordKey`, §6.5 — a stale pre-delete put that would
  resurrect a deleted key),
- or a peer-supplied identity-bearing field that receiver revalidation rejected
  (master spec line 237, the L15 channel-uid-remap case).

### 5.2 Structure + bounds + eviction

```ts
interface QuarantineRecord {
  peer: string;            // authenticated sender
  kind: JournalKind;
  failureClass: 'malformed' | 'oversized' | 'skew-suspicious'
              | 'untrusted-origin' | 'delete-resurrection'
              | 'identity-revalidation-failed';
  recordKey?: string;      // when extractable
  rawTruncated: string;    // first N bytes of the offending line (bounded)
  count: number;           // COALESCED count for this (peer, failureClass) signature
  firstAt: string; lastAt: string;
}
```

- **Bound:** a ring with `maxEntries` (default 256) AND `maxBytes` (default
  256 KB), whichever binds first. Oldest-eviction with a monotonic `lossCounter`
  (evictions never silently vanish — they increment a counter surfaced in
  degradation).
- **Coalescing (the DoS defense AND the noise defense).** Records COALESCE by
  `(peer, failureClass)` signature (master spec line 240-242): a stuck/fast clock
  produces ONE growing counter, not N rows. This is what makes a flood unable to
  evict the good diagnostic rows — a million skew-suspicious records from one peer
  occupy ONE ring slot with `count = 1_000_000`, not a million slots. New DISTINCT
  signatures still get their own slot up to `maxEntries` (so a genuinely diverse
  failure set is still visible).
- **Surface:** ONE rate-limited attention item per `(peer, failureClass)` (master
  spec line 242), never per record. Inspect via `GET /state/quarantine`.
- **Per-peer sustained-failure breaker (master spec line 243).** A peer whose
  quarantine RATE exceeds a threshold over a window trips a breaker: its
  replication stops being accepted (records from it are dropped at the door,
  counted, until the breaker resets) — bounded, never accumulating forever. This
  is the No-Unbounded-Loops arm.

## 6. Component 4 — Snapshot-then-tail (`src/core/StoreSnapshot.ts` + apply path)

A joining / recovering / compacted / long-dark machine must NOT replay a peer's
journal from genesis (master spec line 272-278). The cutover rides the EXISTING
seq-contiguous transport unchanged — `buildServeBatch(kind, fromSeq, ownMachineId)`
already serves one own-stream slice newest→oldest with `seq` contiguity, and the
applier already rejects a forward gap (`seq !== lastHeldSeq + 1 ⇒ invalid`,
JournalSyncApplier.ts:506) and drops a back-fill (`seq <= lastHeldSeq ⇒ duplicate`,
line 505). The whole correctness of the cutover is borrowed from those two existing
guarantees; HLC plays NO role as the tail cursor (it is a SECONDARY dedup filter
only — §6.4).

### 6.1 SINGLE-ORIGIN snapshots (the anti-forgery foundation)

> **Normative decision (closes BLOCKER-2):** a peer may snapshot-serve ONLY the
> records it AUTHORED — i.e. its OWN per-`(machine,kind)` journal stream(s).
> `snapshot.origin === serving machine`, with no exceptions. A snapshot NEVER
> spans foreign origins.

This is forced by the transport's anti-forgery model. `apply()`'s first-hop
binding rejects any entry whose `entry.machine !== authenticatedSender` as
`'forged'` (JournalSyncApplier.ts:486-488), and `buildServeBatch` serves "THIS
machine's OWN stream" only (line 770-776, "First-hop only"). If peer M were
allowed to serve a snapshot containing `origin = N` records, the receiver would
have to vouch for records M did not author — the EXACT case first-hop binding
forbids — letting a compromised M smuggle a forged `origin = N` record (with an
arbitrary sub-`maxDrift` HLC) into N's namespace, surviving even a later un-merge
of M. Single-origin snapshots make that impossible by construction:
`origin === authenticatedSender` holds end-to-end on the snapshot path exactly as
it does on the tail path.

A recovering machine reconstructs the cross-machine store by snapshot-then-tailing
EACH origin SEPARATELY, from a live holder of that origin's stream (normally the
origin machine itself; a relay-holding peer may serve a foreign origin's stream
ONLY if it can prove first-hop authenticity, which today it cannot — so in this
foundation a foreign origin is recovered only from a live origin holder, and an
origin with no live holder is simply absent until it returns, §9 headless). Each
per-origin snapshot is single-origin; the UNION across origins (§7) is what makes
the store cross-machine. This naturally produces the per-origin watermark VECTOR
the tail needs (§6.3).

### 6.2 Snapshot format

A single-origin snapshot of store S from origin M is the CURRENT materialized
state of S's M-authored records (latest record per `recordKey`, deletes
tombstoned within the tombstone horizon, §6.5), serialized as a bounded set of
records, each carrying its `hlc`. Because M authored every record in it, the
snapshot covers exactly the contiguous `seq` prefix of M's `(M, kind)` stream(s)
that materialized into it. The snapshot's **seq-watermark** is therefore a map

```ts
interface SnapshotWatermark {
  origin: string;                       // === serving machine
  // per contributing (origin, kind) stream: the highest journal seq the
  // snapshot materialized from. THIS is the tail cursor.
  kinds: Record<JournalKind, { snapshotSeq: number; }>;
  // SECONDARY: the max HLC over all records in the snapshot — used ONLY as an
  // idempotency/dedup hint at cutover, never as the tail cursor (§6.4).
  maxHlc: HlcTimestamp;
}
```

`snapshotSeq` per `(origin, kind)` is computed deterministically from which
journal entries actually materialized into the snapshot (NOT asserted separately),
so it cannot lie: it is the highest `entry.seq` of an M-authored entry that the
snapshot reflects.

### 6.3 The cutover (no gap, no double-apply — rides the existing seq transport)

For EACH origin M the recovering machine wants to recover (each enabled store, one
origin at a time):

1. The recovering machine requests a single-origin snapshot of (origin M, store S)
   — a read-side mesh verb that builds + serves bounded data.
2. The holder builds the snapshot OFF THE EVENT LOOP (worker thread, chunked,
   bounded batches — the instar#1069 lesson, mirroring `CartographerSweepEngine`
   / `cartographerDetect.worker.ts`). Snapshots are REUSED within a minimum-
   rebuild window (a flapping peer serves the cached snapshot) and a per-peer
   snapshot-build-frequency breaker prevents rebuild storms (master spec line
   277-278). The snapshot cache is itself bounded (§8.2).
3. The recovering machine APPLIES the snapshot into store S's `(origin M)`
   replicated namespace (§7), then SEEDS, per contributing `(M, kind)` stream,
   `PeerMeta.kinds[kind].lastHeldSeq = snapshotWatermark.kinds[kind].snapshotSeq`.
   This is the load-bearing step: it places the existing applier's per-stream
   cursor exactly at the snapshot's seq boundary, so the next ordinary apply is
   already in-contiguity.
4. It then TAILS each `(M, kind)` stream via the UNCHANGED transport:
   `buildServeBatch(kind, snapshotSeq, M)` serves entries with `seq > snapshotSeq`
   ascending; the applier accepts `seq === lastHeldSeq + 1` and onward. **No gap**
   and **no double-apply** fall directly out of the transport's existing
   contiguity guarantee (JournalSyncApplier.ts:505-506) — the same machinery that
   already protects steady-state replication. There is NO new gap-detection code
   on the cutover; the seq sentinel already there does the work.
5. Idempotency: re-running the whole snapshot-then-tail is safe — re-seeding the
   cursor to the same `snapshotSeq` and re-tailing replays the same contiguous
   suffix; an entry at or below the already-held seq is dropped as a `duplicate`
   by the existing rule (line 505), and applying a snapshot is a per-`recordKey`
   HLC-max merge (an already-present newer record is not overwritten by an older
   snapshot record).

### 6.4 HLC's role at cutover (demoted to a SECONDARY dedup filter only)

HLC is NOT the tail cursor. The cutover is entirely seq-driven (§6.3). HLC is used
at cutover for ONE thing only: a belt-and-suspenders idempotency hint. When the
snapshot and the seq-tail are stitched, the applier additionally drops any record
whose `(recordKey, origin, hlc)` identity it has already merged — this catches a
buggy holder that re-serves a record already in the snapshot even though its seq
math says otherwise. This is a redundant safety net layered ON the seq contiguity,
never a substitute for it.

> **Removed false claims (per BLOCKER-1):** the prior draft claimed (a) filtering
> `hlc > W` against a single scalar watermark `W` is gap-free, and (b) the
> HLC-filtered tail "reuses the applier's existing gap sentinel machinery." Both
> were wrong: a single scalar max-HLC cannot bound a cross-origin store union, the
> applier's gap sentinel is SEQ-keyed (it does not apply to an HLC-filtered tail),
> and a record with `hlc ≤ W` arriving on a lagging stream after the cut would be
> silently excluded by a strict `> W` filter and LOST. The per-origin seq-watermark
> vector + the existing seq transport replace that mechanism entirely.

### 6.5 Tombstone safety — no delete-resurrection (closes BLOCKER-3)

A delete is a tombstone record (`op: 'delete'`) carrying its own `hlc` and `seq`.
The union-reader (§7.2) resolves per key by HLC-max, so a tombstone only suppresses
a put while the tombstone is still present in the union. Two invariants prevent a
deleted key from RESURRECTING when a tombstone ages out before a long-dark peer
reconverges:

1. **Per-store deleted-keys high-water (the always-on guard).** Each store
   persists, per `recordKey`, the HLC of the highest-HLC `delete` it has ever
   applied — a `deleteWatermark[recordKey]`. An incoming `put` whose `hlc` is
   `compare`-below `deleteWatermark[recordKey]` is DROPPED as a resurrection
   attempt (counted, surfaced — never silently applied). This survives tombstone
   GC: even after the tombstone record itself rotates out, the deleted-keys
   high-water remembers the delete dominated everything below it. The high-water
   map is bounded by the live key count (a key whose deleteWatermark is provably
   dominated by a later put for the same key — a legitimate re-create — clears its
   entry).
2. **Long-dark peers re-join via FULL snapshot, never tail.** A peer dark longer
   than the **tombstone horizon** (the per-kind retention window over which a
   tombstone is guaranteed still present) MUST recover via a full single-origin
   snapshot (§6.1), NOT a seq-tail from a stale `lastHeldSeq` — because the tail
   may begin AFTER the delete tombstone rotated out, which would replay only the
   pre-delete put. The applier already DETECTS this condition: a `fromSeq` below
   the holder's `oldestRetainedSeq` records a gap sentinel + `gapped` status
   (JournalSyncApplier.ts:387-399, rule 4). **The foundation adds a NEW reaction to
   that existing signal:** for a replicated-store kind, a `gapped` `(origin, kind)`
   triggers a full single-origin snapshot re-join instead of the legacy
   fast-forward (which would skip the tombstone). This is a deliberate behavioral
   ADDITION on top of the existing detection — not a claim that the applier already
   does it. Non-replicated kinds keep the legacy fast-forward unchanged.

**Converged-tombstone-GC (the stronger, optional eviction condition).** Where a
store can afford to bound the deleted-keys high-water more tightly, a tombstone for
K becomes eligible for eviction (and its high-water entry clearable) ONLY when
every pool peer's per-origin last-applied watermark for K's origin is provably
`compare`-past the tombstone's HLC — i.e. every peer has already seen the delete.
Until then the tombstone is retained even past the normal retention window. This is
the converged-GC arm; the deleted-keys high-water (guard 1) is the always-on floor
that makes resurrection impossible even if converged-GC is not yet wired.

### 6.6 Why a seq-watermark VECTOR (not a scalar HLC, not a single seq)

`seq` is per-`(machine,kind)`. A store's replicated state is a UNION across many
origins, each origin contributing one (or more) `(origin, kind)` streams. A single
scalar — whether a max-HLC `W` or one `seq` — cannot bound a union of independently-
advancing streams: a lagging stream's next record may have an HLC below `W` yet be
genuinely un-applied. The correct watermark is therefore a VECTOR of per-`(origin,
kind)` `snapshotSeq` values, each riding its own stream's existing contiguity.
This vector is exactly a bounded, per-pool-size version vector (§7.2, §15-risk-1)
— acknowledged and analyzed honestly rather than pretended away.

## 7. Component 5 — Origin tags + Component 6 — Union-reader + rollback-unmerge

### 7.1 Namespaced storage + origin tag

Every applied replicated record lives in a NAMESPACED store location keyed by
origin (master spec line 246-249). Concretely: the journal's replica layout
already isolates peer M's stream at `peers/<safeMachineId(M)>.<kind>.jsonl`. A
store's materialized replicated state is derived per-origin from those replica
streams; the local-origin state is derived from the OWN stream. Every record's
`origin` field (= author machine id) is preserved end-to-end. This is what makes
rollback a real un-merge, not a flag wish.

### 7.2 Union-reader discipline (the no-clobber rule)

A store read returns the UNION of local + replicated state, implemented at the
LOWEST store-access primitive so no caller can bypass it (master spec line
279-283; enforced by a wiring-integrity test, §12). The merge rule per
`recordKey`:

- If only one origin has a record for the key ⇒ return it.
- If multiple origins have records for the key and one is provably
  SEQUENTIAL-AFTER the other (the later writer's `observed[K]` witness proves it had
  already seen the earlier — see the detector below) ⇒ the later wins (a normal
  sequential edit history; `field-level HLC-wins`, correct, no conflict).
- If multiple origins have records for the key that are CONCURRENT (no witness
  proves either saw the other — divergent edits made during a partition) ⇒ the
  behavior depends on the store's impact tier:
  - **High-impact stores (preferences, relationships):** APPEND-BOTH-AND-FLAG
    (master spec decision 2, line 509). Both versions are preserved in the union
    (neither clobbers the other), the conflict is marked with a stable
    `conflictId = hash(recordKey, sorted version-pair)`, and ONE deduped attention
    item is raised. Append-both is IDEMPOTENT on `(recordKey, version-pair)` — re-
    discovering the same unresolved conflict never appends a third copy. A conflict
    recurring past a threshold escalates to forced operator resolution.
  - **Low-impact stores (scores, manifests):** field-level HLC-wins WITH a
    divergence flag (master spec line 253-254). The latest HLC wins but the
    overwrite is flagged, not silent.
- A replicated record NEVER clobbers a DIVERGENT local record. This is the
  invariant the whole foundation exists to guarantee: reach is not authority.

**Concurrency detection (a SOUND primitive — closes BLOCKER-4).** Plain
`HybridLogicalClock.compare` is a TOTAL order: it NEVER returns "concurrent," and a
single per-origin scalar watermark cannot tell "I causally saw your edit" apart
from "my physical clock merely advanced past yours." Using `compare` (plus a scalar
watermark) as a concurrency test is therefore unsound in BOTH directions — it
over-flags sequential edits AND can silently HLC-resolve (clobber) a genuinely
concurrent pair, breaking the "conservative direction is SAFE" claim. We replace it
with a **last-writer-witness**:

- Every authored record carries, alongside its `hlc`, a bounded **`observed`**
  witness: `observed[recordKey] = the HLC the author had already merged for that
  recordKey at author time` (i.e. the HLC of the latest version of K the author
  had applied before writing). This is one extra HLC per record — bounded, not a
  full vector per record.
- Write `W2` is **sequential-after** `W1` (same `recordKey` K, different origins)
  IFF `compare(W2.observed[K], W1.hlc) >= 0` — W2's author had already seen (≥) W1
  when it wrote. Otherwise the two are **concurrent** ⇒ FLAG (append-both for
  high-impact, HLC-wins-with-flag for low-impact).
- **Provable err-toward-flag.** If `W2.observed[K]` is missing or below `W1.hlc`,
  we cannot prove W2 saw W1, so we flag — never resolve. The ONLY way a pair is
  treated as sequential is a positive witness that one saw the other. A clock
  arranged to make a concurrent pair `compare` cleanly cannot make
  `observed[K] >= the-other.hlc` true unless the author genuinely merged it first
  — so the witness, not the wall clock, decides, and the error direction is always
  toward flag. The §12 #5 test asserts this with an adversarial clock layout.

**Honest cost (reconciles the §15-risk-1 contradiction).** This witness IS a
bounded version vector — the spec no longer claims to "avoid version vectors." The
bound: ONE extra HLC per record on the wire (`observed[recordKey]`, the single
relevant key, not the whole keyspace), plus the per-`(origin,kind)` seq-watermark
vector at the store level (§6.6) which is O(online-origins × kinds) per store —
bounded by the hard pool-wide ceiling (§8.1), persisted, recomputed live. This is a
COARSE, per-pool-size-bounded version vector, not the unbounded per-key vector a
full CRDT would carry. §15-risk-1 is updated to own this explicitly.

### 7.3 Conflict resolution path (delegated UP, never decided here)

Every flagged conflict carries its stable `conflictId`. An authenticated
`POST /state/resolve-conflict` lets the OPERATOR designate a winner or supply a
merged version (master spec line 257-261); a dashboard surface exposes open
conflicts. This foundation NEVER picks a winner — that is the one judgment call,
and it is the operator's (Signal vs Authority, §11). Unresolved conflicts are
bounded, visible, and resolvable.

### 7.4 Rollback-unmerge (deterministic, no dangling references)

Disabling `multiMachine.stateSync.<store>` for a peer (or globally) atomically
DROPS that origin's foreign namespace (master spec line 248): a real un-merge,
not a flag. Mechanically:

1. The store's union-reader stops including the dropped origin's namespace on the
   NEXT read (the union is computed live from the per-origin namespaces, so
   removing a namespace removes its contribution instantly — no rewrite needed).
2. The dropped origin's replica streams + per-peer meta + any snapshot cache for
   it are quarantined-aside (rename, then bounded-retain) so the un-merge is
   reversible and auditable, never a destructive delete.
3. **No dangling references.** Because records are keyed by `(recordKey, origin)`
   and the union recomputes live, dropping an origin cannot leave a half-merged
   value: any key whose winning value came from the dropped origin reverts to the
   HLC-latest among the REMAINING origins (or to "no record" if none remains).
   Any `conflictId` whose version-pair referenced the dropped origin is
   auto-RESOLVED (the conflict no longer exists) and its attention item closed.
   A wiring-integrity test asserts: after an un-merge, every surviving union read
   resolves with zero references to the dropped origin.

## 8. Component 7 — Bounds (the aggregate journal budget)

Per master spec line 263-271:

- **Per-store, per-record-class bounds (tested):** each new replicated kind ships
  its `maxFileBytes` + `rotateKeep` retention entry AND its token-bucket rate cap
  in the same PR (the journal's existing `DEFAULT_RETENTION` / `DEFAULT_RATE_CAP`
  machinery, extended per kind). Max entries per sync batch + max bytes per store.
- **Replication rate cap with COALESCING:** replicate the LATEST state per
  `recordKey` per interval, not every intermediate write (master spec line
  264-265). A burst of edits to one key collapses to one replicated record per
  interval.
- **AGGREGATE replicated-journal budget (the anti-starvation invariant):** a
  config-declared ceiling (`multiMachine.stateSync.aggregateJournalBudgetBytes`)
  caps the TOTAL bytes/sec across ALL replicated kinds, so one chatty store cannot
  starve the others. When the aggregate budget is pressured, the per-kind rate
  caps are throttled proportionally (fair-share), and the throttle is surfaced in
  degradation (never a silent stall). A test enforces the budget ACROSS kinds (a
  flood on kind A must not consume kind B's share).
- **Sustained-failure breaker** when a peer rejects repeatedly (the §5.2 per-peer
  breaker, shared).
- **Dark-peer accumulation bound:** replication to an unreachable peer does NOT
  buffer unbounded history (the journal's retention window bounds it); past the
  window the recovering peer re-syncs via snapshot-then-tail (§6), not by
  buffering. A peer dark past the **tombstone horizon** is FORCED to a full
  single-origin snapshot re-join (§6.5), never a stale-seq tail — the delete-
  resurrection guard.
- **Tombstone horizon:** the per-kind retention window over which a `delete`
  tombstone is guaranteed still present (`multiMachine.stateSync.<store>` inherits
  the kind's `maxFileBytes`+`rotateKeep` window; for `rotateKeep: 0` "never delete"
  kinds the horizon is effectively unbounded and tombstones never need GC). The
  always-on deleted-keys high-water (§6.5 guard 1) makes resurrection impossible
  regardless of where the horizon falls.

### 8.1 Phase C — budgets scale by pool size

The aggregate budget and the per-kind caps are expressed as PER-PEER allowances
multiplied by the live online-peer count (bounded by a hard pool-wide ceiling),
NOT a 2-machine constant. A 5-machine pool gets a proportionally larger aggregate
budget than a 2-machine pool, but never unbounded — the hard ceiling protects a
single machine's disk/CPU. The pool-size input is the live capacity-heartbeat
peer count; a transient peer-count spike does not instantly widen the budget
(hysteresis on the multiplier).

### 8.2 Snapshot-cache fixed ceiling (closes BLOCKER-6a)

§6.3 reuses a cached snapshot within a minimum-rebuild window — but the CACHE
itself must be bounded, independently of pool size, or it becomes an
O(N peers × M stores) structure with no eviction (every OTHER bound in this spec is
explicit; this was the one gap). The snapshot cache is a ring with a FIXED ceiling,
NOT pool-size-scaled:

- `multiMachine.stateSync.maxCachedSnapshots` (default **16**) AND
  `multiMachine.stateSync.maxCacheBytes` (default **64 MB**), whichever binds
  first. Both are absolute constants, NOT multiplied by peer count.
- **LRU eviction with a monotonic `cacheLossCounter`** (mirroring the quarantine
  ring's `lossCounter`, §5.2) — an evicted snapshot is just rebuilt on next demand
  (the rebuild is breaker-gated, §6.3), so eviction is never a correctness loss,
  only a recompute; the counter makes the recompute visible in degradation.
- A snapshot is keyed by `(origin, store, snapshotWatermark.maxHlc)`; a stale entry
  is dropped when its source stream advances past it. The cache holds AT MOST
  `maxCachedSnapshots` live entries regardless of how many (peer × store) pairs
  request snapshots — a large pool simply rebuilds more often, bounded by the
  per-peer rebuild breaker.

## 9. Phase C — N-machine (NOT 2-peer), no-LAN, headless

The master spec's hardest constraint. Every primitive here is designed for N
machines from the start:

- **HLC node-id space:** `node` is the string machine id — unbounded id space, no
  small-integer assumption. `compare`'s final tie-break is lexicographic over
  machine ids, which is total for any N.
- **Convergence semantics that don't assume 2 peers:** the union-reader merges
  ALL origins (not "local vs the one peer"); append-both-and-flag handles a
  version SET, not a version pair only — N concurrent edits to one key produce N
  preserved versions and ONE conflict (with all N in the version-set), not
  N-choose-2 pairwise conflicts. There is NO quorum requirement: the design is
  eventually-consistent + operator-resolvable, not consensus-based, so it works
  with any reachable subset of the pool (a partition just means later
  reconciliation, never a stall).
- **No-LAN assumption:** all transport is the existing authenticated mesh RPC over
  the Cloudflare tunnel (cloud VMs, no broadcast, no mDNS, one-way-NAT-tolerant).
  Snapshot pull, tail request, and quarantine surfacing are all RPC; nothing
  assumes peers share a network segment. The existing journal-sync transport
  already runs this way.
- **Headless enrollment:** a new machine joins by registering in the pool
  (existing `MachinePoolRegistry` + capacity heartbeat) and advertising its
  `stateSync.<store>` flags; it then snapshot-then-tails each enabled store from a
  live peer. No interactive step — a headless cloud VM enrolls the same way as a
  laptop. The HLC clock seeds from `now()` and converges via `receive()` on first
  inbound.
- **Budgets scale by pool size:** §8.1.

## 10. Safety, rollout posture, Migration & Awareness

### 10.1 Safety & rollout posture (ships DARK)

- **Master flag:** `multiMachine.stateSync` (an object). The foundation primitives
  are inert unless at least one `stateSync.<store>.enabled` is true. Per-store
  flags ship `enabled: false` by default → **default preserves today's behavior
  exactly** (no replicated kinds emitted, no union-reader foreign namespace, no
  HLC stamping on local writes beyond the cheap in-memory clock that no one
  reads). A foundation-level `multiMachine.stateSync.foundation` is NOT needed —
  the per-store flags ARE the foundation's on-switch, store by store.
- **Dry-run:** every store's merge path has a dry-run mode
  (`multiMachine.stateSync.<store>.dryRun`, default true on first enable) — log
  intended merges/applies/un-merges WITHOUT mutating store state. The graduated
  rollout track: `dark` (flag off) → `dryRun` (emit + log intended merges) →
  `live` (real merges). This mirrors the `sessionPool.stage` ladder.
- **Single-machine = strict no-op.** With no registered peers (pool dark or size
  1) NO foundation code path is entered: emission is gated on having a peer
  advertising the matching flag; the union-reader's foreign namespace is empty;
  snapshot-then-tail has no peer to pull from; the quarantine ring never receives.
  Guard on pool MEMBERSHIP, not just config (master spec §5/§6).

### 10.2 Migration & Awareness (Migration Parity Standard)

- **Config:** add `multiMachine.stateSync` to `migrateConfig()` (in
  `PostUpdateMigrator` / `ConfigDefaults`) with an EXISTENCE check — only add the
  object + per-store `{ enabled:false, dryRun:true }` defaults if absent.
  Idempotent. Add `aggregateJournalBudgetBytes`, `maxDriftMs`,
  `maxCachedSnapshots`, and `maxCacheBytes` the same way. Cross-knob invariants
  validated at startup via a `validateStateSyncInvariants()` mirroring
  `validateSeamlessnessInvariants()` — a bad config is REJECTED, not silently
  degraded:
  - `aggregateJournalBudgetBytes > 0`; per-kind cap ≤ aggregate.
  - `maxDriftMs` within `[60_000, 900_000]` (the §3.4 clamp) — a value outside is
    rejected, not silently coerced.
  - `maxDriftMs > flush interval + propagation allowance`, NOT the prior vacuous
    "maxDriftMs > flush window". Concretely: `maxDriftMs > DEFAULT_FLUSH_INTERVAL_MS
    (250) + a propagation allowance` so the bound can never be tighter than the
    journal's own flush+replicate latency (which would quarantine our own
    in-flight writes). With the 60s floor this always holds, but the invariant is
    stated explicitly rather than relying on the floor.
  - `maxCachedSnapshots > 0` and `maxCacheBytes > 0` (§8.2).
- **Capability advert (additive):** extend `MachineCapacity.seamlessnessFlags`
  with per-store booleans (`ws2PrefReceive`, `ws2RelationshipReceive`, …) advertised
  in the capacity heartbeat (populated in `server.ts` next to the existing
  `ws11DeliverReceive`). **ABSENT = non-participant** for that store (the
  conservative side — a sender never emits a store's kind to a peer that cannot
  durably receive it; the named skew-failure-mode prevention). Fixed-size
  booleans only, never an inventory.
- **CLAUDE.md awareness:** `generateClaudeMd()` (new-agent path) +
  `migrateClaudeMd()` (existing-agent path, content-sniff-guarded, idempotent) add
  a "One Memory (replicated stores)" section: what replicates, the union-reader +
  append-both-and-flag behavior in plain words, the `GET /state/quarantine` /
  `GET /state/conflicts` / `POST /state/resolve-conflict` surfaces, and the
  proactive trigger ("user asks 'why do I have two versions of preference X?' →
  read open conflicts; user asks 'roll back machine Y's data' → un-merge").
- **Idempotency:** every migration checks before patching; safe to run N times.

## 11. Multi-machine posture (Cross-Machine Coherence) + signal-vs-authority

| Component | Posture |
|---|---|
| HybridLogicalClock | **machine-local-by-design** (each machine has its own clock; clocks CONVERGE via `receive()` but are never shared state). The HLC TIMESTAMPS are replicated (on each record); the clock object is not. |
| Replicated kinds (emission) | **replicated** — emitted on the OWN journal stream, forwarded over the existing journal-sync mesh transport, flag-coherence-gated per peer. |
| Quarantine ring | **machine-local-by-design** — each machine quarantines what IT received; quarantine state is not replicated (a peer's quarantine is its own business). Surfaced locally. |
| Snapshot build/serve | **proxied-on-read** — a recovering machine PULLS a snapshot from a live peer (read-side mesh verb); the peer builds it off-loop and may serve a cached copy. |
| Union-reader | **machine-local-by-design** (computed live from local own + local replica namespaces — no cross-machine call on the read path; replication is what populated the replica namespaces earlier). |
| Rollback-unmerge | **machine-local-by-design** — a machine un-merges ITS OWN copy of a peer's namespace; it does not reach into the peer. |
| Conflict records | **machine-local** detection; the RESOLUTION (`POST /state/resolve-conflict`) writes an operator-authored record that itself replicates as a normal record. |

**Signal vs Authority.** This foundation is MECHANISM, not a gate. It orders
(HLC), validates + quarantines (receiver gate), unions (read), and un-merges
(rollback). It NEVER actuates (no kill/spawn/place/transfer — it inherits the
journal's §3.9 actuation ban) and NEVER decides a conflict winner (append-both-
and-flag defers that to the operator). The one mutating authority it grants —
`POST /state/resolve-conflict` — is operator-authenticated and writes a normal
replicated record; it is the operator's authority, surfaced, not the foundation's.

### 11.1 Threat model (made explicit)

The boundary this foundation defends, stated as reviewable claims rather than
implicit assumptions:

- **Pool composition:** a SINGLE operator's machines, mutually trusted, on an
  Ed25519-authenticated mesh (the existing transport). There is no untrusted
  third-party participant; the threat is a COMPROMISED or BUGGY peer inside the
  operator's own pool, plus clock skew / NTP failure.
- **A compromised peer is bounded to corrupting records under ITS OWN origin.**
  First-hop sender binding (tail) + single-origin snapshots (§6.1) together make
  `origin === authenticatedSender` hold on BOTH replication paths — so a
  compromised peer M can only forge records under `origin = M`, never under another
  machine's origin. The operator's recourse for a bad origin is rollback-unmerge
  (§7.4), which cleanly drops that origin's whole contribution.
- **Cross-origin forgery is prevented by construction** (single-origin snapshots),
  not by revalidation — the journal does not per-record-sign today (the heavier
  alternative B in §6.1 is named but not chosen). Test #12 locks this.
- **A store replicates in FULL to every advertising peer — there is no per-record
  ACL.** This is the WS2.3 PII implication: enabling the relationships/user-registry
  store means every advertising machine holds the full personal-data set. That is
  exactly why WS2.3 ships behind its own security-convergence round on top of this
  foundation (master-spec deferral); this foundation fixes the BOUNDARY (single-
  origin snapshots, origin-tagged rollback, receiver revalidation) the WS2.3 round
  builds on.
- **Clock skew is bounded by `maxDriftMs` (§3.4), pool-relative, fixed-constant
  this round.** A fast clock cannot win every merge; a machine flagged
  `suspect-clock-removed` is barred by the existing FSM.

## 12. Test plan (three tiers + named invariant tests)

**Tier 1 — Unit** (`tests/unit/`): HLC operations against an injected fake clock;
quarantine ring bounds/coalescing/eviction; snapshot per-`(origin,kind)`
seq-watermark computation; snapshot-cache LRU bound + lossCounter; union merge rule
(each branch); last-writer-witness concurrency detector (both directions + the
err-toward-flag adversarial case); deleted-keys high-water resurrection drop;
un-merge live recompute; `maxDriftMs` clamp + pool-relative reference check.

**Tier 2 — Integration** (`tests/integration/`): the full HTTP pipeline —
`GET /state/quarantine`, `GET /state/conflicts`, `POST /state/resolve-conflict`,
the snapshot-pull + tail mesh verbs — return real data when a store is enabled,
503 when dark.

**Tier 3 — E2E feature-alive** (`tests/e2e/`): the production init path mirroring
`server.ts` — with a store enabled, a replicated record authored on machine A is
union-readable on machine B (returns 200, real value, not 503). This is the
single most important test.

**Named invariant tests (the master spec line 463 requires "WS2 quarantine +
rollback-unmerge"; these are the full set):**
1. **HLC total-order + monotonicity under concurrent/skewed inputs:** property
   test — random interleavings of `tick`/`receive` with a fake clock that jumps
   forward AND backward never produce a non-monotonic local sequence; `compare`
   is a total order (irreflexive, antisymmetric, transitive) over a generated set.
2. **HLC fast-clock rejection:** a `receive()` of a record `> maxDriftMs` ahead
   returns `SkewRejection` and does NOT advance the local clock (no poisoning).
3. **Snapshot-then-tail completeness (no gap, no double-apply) across a
   compaction, SEQ-DRIVEN:** take per-origin single-origin snapshots carrying the
   `(origin,kind) → snapshotSeq` watermark vector; seed each stream's
   `lastHeldSeq = snapshotSeq`; then tail via `buildServeBatch(kind, snapshotSeq,
   origin)`. Assert the union after tail equals the union of replaying the full
   journal from genesis (completeness — across MULTIPLE origins, not just one) AND
   no record is applied twice (idempotency), INCLUDING when the snapshot is
   re-applied (flapping-peer reuse). Assert the no-gap/no-double-apply guarantee
   comes from the EXISTING seq contiguity (a record on a lagging stream with an HLC
   below another stream's max is still applied — the scalar-W-filter loss the old
   design had is NOT reproducible).
4. **Quarantine rejects malformed/oversized/bad-origin + bounded + coalesced:**
   feed each failure class; assert quarantined (not applied, not dropped),
   coalesced by (peer, failureClass), ring stays within maxEntries/maxBytes under
   a flood, lossCounter increments on eviction, per-peer breaker trips.
5. **Union-reader no-clobber + append-both-and-flag + SOUND-detector
   err-direction:** a replicated record concurrent with a divergent local record
   for the same key ⇒ BOTH preserved, ONE conflict flagged, idempotent on
   re-discovery; a CAUSALLY LATER replicated record (positive `observed[K]`
   witness ≥ the local hlc) ⇒ HLC-wins (no false conflict). **Adversarial err-
   direction (MANDATED):** arrange a genuinely-concurrent pair whose physical
   clocks make `compare` resolve them CLEANLY (one appears strictly later) but
   whose `observed[K]` witnesses prove neither saw the other — assert the detector
   FLAGS (never silently HLC-resolves). Assert the error direction is ALWAYS toward
   flag: a missing/below-threshold `observed[K]` never resolves, only flags.
6. **Rollback-unmerge restores prior state + no dangling refs:** un-merge a peer
   ⇒ every surviving union read resolves with zero references to the dropped
   origin; conflicts referencing it auto-resolve; reversible (re-merge restores).
7. **Version-skew matrix (new↔old, mixed-flag):** new emits a replicated kind, old
   peer silently drops it (forward-compat, no crash); flag-coherence gate refuses
   to emit to a non-advertising peer; mixed-flag pool degrades conservatively.
8. **Single-machine strict no-op:** pool size 1 ⇒ no foundation code path entered;
   local writes behave byte-for-byte as today.
9. **Aggregate-budget fairness (burst):** a burst flood on kind A does not consume
   kind B's replication share; budget scales by pool size with hysteresis. (The
   SUSTAINED-pressure companion is test #15 — the standard mandates both.)
10. **Burst-invariant for the new notice paths** (`tests/integration/`): an
    N-machine quarantine/conflict storm produces ONE coalesced attention item per
    (peer, failure-class) / per conflictId, never N — reusing the WS3.3 episode-key
    burst-invariant harness (`notification-flood-burst-invariant.test.ts`).
11. **Wiring-integrity:** every store read callsite routes through the union-reader
    primitive (no direct-path reader remains — audited + locked by a test); the
    HLC clock, quarantine ring, and snapshot engine are dependency-injected and
    not null / not no-ops.
12. **Cross-origin forgery is impossible via tail OR snapshot (closes BLOCKER-2):**
    a peer M cannot inject a record under an origin `N != M` — via the steady-state
    tail (first-hop binding rejects it as `forged`, JournalSyncApplier.ts:486-488)
    AND via a snapshot (single-origin snapshots, §6.1: a snapshot served by M
    carries only `origin = M` records; a snapshot containing any `origin != serving
    machine` record is rejected wholesale). Assert a forged `origin = N` record in
    a snapshot from M is quarantined as `untrusted-origin`, never landed in N's
    namespace, and does not survive a later un-merge of M.
13. **Tombstone safety — no delete-resurrection (P19, closes BLOCKER-3):** delete
    key K (tombstone at HLC t1); GC/evict the tombstone record; then re-merge a
    PRE-delete put for K (HLC < t1) from a stale peer ⇒ K STAYS DELETED (the
    deleted-keys high-water drops the put as a resurrection, counted + surfaced).
    Separately: a peer dark longer than the tombstone horizon re-joining via tail
    from a stale `lastHeldSeq` below the holder's `oldestRetainedSeq` is FORCED to
    full-snapshot re-join (truncation signal), not a lossy fast-forward. A
    legitimate re-create (put with HLC > t1) is accepted and clears the high-water.
14. **Snapshot-build breaker under SUSTAINED flapping (P19, closes BLOCKER-6b):**
    continuous rebuild requests from a flapping peer over MULTIPLE windows ⇒ actual
    rebuilds stay BOUNDED (cached snapshot served between rebuilds), the breaker
    trips AND resets across windows, and the build stays off the event loop (CPU /
    event-loop-lag bounded — mirroring the instar#1069 worker-offload assertion).
    Plus: the snapshot cache stays within `maxCachedSnapshots` / `maxCacheBytes`
    under sustained distinct-snapshot demand, `cacheLossCounter` increments on LRU
    eviction.
15. **Aggregate-budget throttle under SUSTAINED pressure (P19, closes BLOCKER-6b):**
    a store at a SATURATING write rate held over multiple windows stays within its
    fair-share, the throttle is CONTINUOUSLY surfaced in degradation (not a
    one-shot), and OTHER stores keep their replication share throughout (no
    starvation under sustained, not just burst, pressure).

## 13. Build order (dependency order — so WS2.1/WS2.3 can layer on top)

1. **HybridLogicalClock** (`src/core/HybridLogicalClock.ts`) — pure, no deps;
   everything downstream needs the total order. The fixed-constant `maxDriftMs`
   clamp + pool-relative reference (§3.4) land here. Unit tests first.
2. **Journal-kind machinery + replicated-record envelope** — the generic schema
   (incl. `observed` witness + `op`/`origin`) + flag-gated, flag-coherence-gated
   emission (no concrete store yet).
3. **Snapshot-then-tail** (`StoreSnapshot.ts` + the apply-path cutover) — produces
   the per-`(origin,kind)` seq-watermark VECTOR (§6.6), single-origin (§6.1), seeds
   `lastHeldSeq` and rides the EXISTING `buildServeBatch` seq transport. Includes
   the snapshot-cache fixed ceiling (§8.2). Needs HLC only as the secondary dedup
   hint, NOT the cursor.
4. **Quarantine ring** (`ReplicationQuarantine.ts`) + **union-reader** discipline
   (incl. the last-writer-witness concurrency detector, §7.2) + **tombstone safety**
   (deleted-keys high-water + full-snapshot-on-stale-tail, §6.5) +
   **rollback-unmerge** — the receive/read/rollback triad; needs HLC + the envelope
   (the `observed` witness).
5. **Bounds** — per-kind caps wired into the journal's retention machinery + the
   aggregate budget + the per-peer breaker + the snapshot-cache ceiling.
6. **Config + advert + awareness migrations** (§10) — ship with step 2 onward so
   the dark-by-default posture is real from the first PR. `validateStateSyncInvariants`
   (incl. the `maxDriftMs` clamp + cache-ceiling invariants) lands here.

WS2.1 (preferences) is the first CONSUMER and lands AFTER step 4; WS2.3
(relationships + user registry) lands behind its own security-convergence round
(master spec deferral) on top of the same substrate.

## 14. Decision points touched

- **Conflict on divergent concurrent edit** → append-both-and-flag (high-impact)
  / HLC-wins-with-flag (low-impact). Resolved by the master spec (decision 2); the
  WINNER is never chosen by this foundation — delegated to the operator via
  `POST /state/resolve-conflict`. The last-writer-witness concurrency detector
  (§7.2) has a PROVABLE err-toward-flag (a resolvable flag) over silent clobber:
  the only path to "sequential" is a positive `observed[K]` witness.
- **Skew-suspicious record** → quarantine, never merge (HLC `receive` rejection).
  No operator confirmation needed to quarantine (it's the safe direction); the
  operator sees the coalesced attention item.
- **Rollback-unmerge** is an operator/config action (disabling
  `stateSync.<store>`), not an autonomous one — it is reversible and auditable.
- **No gate in this foundation blocks a user-initiated action.** It is mechanism;
  the only refusals are at the receive door (quarantine bad peer data) and the
  emission door (don't emit to a non-advertising peer) — both protect the user's
  data, neither blocks the user.

## 15. Known risks / open questions for convergence

1. **The concurrency detector IS a bounded version vector — owned, not avoided.**
   Earlier drafts claimed to "avoid version vectors"; that was wrong, and §7.2 now
   says so. The sound last-writer-witness (`observed[recordKey]`, one HLC per
   record) plus the store-level per-`(origin,kind)` seq-watermark vector (§6.6)
   together ARE a coarse, per-pool-size-bounded version vector — NOT the unbounded
   per-key vector a full CRDT carries. COST (analyzed honestly): one extra HLC per
   record on the wire; O(online-origins × kinds) per store at rest, bounded by the
   §8.1 hard pool ceiling; persisted; recomputed live. The detector has a PROVABLE
   err-toward-flag (§7.2): the only path to "sequential" is a positive witness. RISK
   that REMAINS: on a high-edit-rate store with frequent partitions the err-toward-
   flag bias could over-flag, raising operator-resolution fatigue. MITIGATION
   shipped: idempotent append-both (no third copy), recurrence threshold → forced
   resolution, and the false-concurrent rate is measured via feature metrics. OPEN
   for the security-convergence round: is the over-flag rate acceptable for
   preferences/relationships, or should the witness be widened to a small per-key
   vector? Proposed: ship the bounded witness, measure, widen only if needed.
2. **Quarantine-ring DoS via DISTINCT signatures.** Coalescing defends against a
   flood of the SAME (peer, failureClass), but a peer that varies its failure
   class or recordKey could still churn distinct ring slots. MITIGATION: the
   per-peer sustained-failure breaker trips on RATE regardless of signature
   diversity (a peer over the rate threshold is cut off at the door before its
   diversity matters). Residual: the breaker's window/threshold tuning — too tight
   cuts off a genuinely-buggy-but-honest peer; too loose lets a slow churn evict
   good rows. Proposed defaults conservative; tunable; surfaced.
3. **Aggregate-budget gaming.** Could one store starve others by authoring under a
   DIFFERENT store's flag? No — emission is keyed on the authoring store's kind;
   the budget is per-kind-fair-share under the aggregate ceiling. Could a peer
   game OUR budget by flooding inbound? That is the receive side (quarantine +
   breaker), not the emission budget — separate defense. Residual: the fair-share
   throttle under sustained pressure could make a legitimately-busy store
   replicate slowly; the throttle is surfaced in degradation so it's visible, but
   a user might perceive "memory is slow to sync." Proposed: alert when a store is
   budget-throttled past a window.
4. **Rollback-unmerge of an origin that AUTHORED a conflict resolution.** If the
   operator resolved conflict C by designating peer M's version, then later
   un-merges M — the resolution record (operator-authored, local origin) survives
   (it's not M's namespace), but the value it pointed AT (M's version) is gone.
   MITIGATION: a resolution record stores the CHOSEN VALUE inline (a copy), not a
   reference to M's record — so un-merging M cannot leave the resolution dangling.
   This must be enforced in WS2.x's resolution-record schema; flagged here as a
   foundation REQUIREMENT on consumers.
5. **Snapshot freshness vs the minimum-rebuild window.** A flapping peer served a
   CACHED snapshot might seed a slightly stale per-`(origin,kind)` `snapshotSeq`
   and re-pull slightly more journal than necessary — correctness-safe (no
   gap/double-apply, §6.3, since the existing seq contiguity covers the overlap as
   duplicates) but mildly wasteful. Accepted: the rebuild breaker's whole point is
   to trade a little re-tail for not melting the CPU on a flapping peer.
6. **Clock-skew bound sourcing (corrected — BLOCKER-5).** `maxDriftMs` is a FIXED
   config constant (default 5min, clamped `[60s, 15min]`) in THIS foundation — it
   is NOT derived from any measured pool skew, because no numeric pool-skew quantity
   exists: `ClockSkewStatus` is a 3-VALUE CATEGORICAL enum (`types.ts:1851`), not a
   millisecond measurement, and citing it as a numeric source was the defect. The
   drift check references a POOL-RELATIVE floor `max(local durable past, observed
   pool reference)`, not the bare local `now()`, so a slow receiver does not
   quarantine a legitimately-ahead peer (§3.4). FUTURE-WORK (named, out of scope
   here): a real measured-skew primitive (`max |routerReceivedAt −
   selfReportedLastSeen|` across online peers, with hysteresis, same clamp) that
   would let `maxDriftMs` auto-tighten — a follow-on spec. OPEN for convergence
   (unchanged): should a machine in `suspect-clock-removed` (the existing FSM) be
   barred from AUTHORING replicated records entirely (its HLC stamps are
   untrustworthy)? Leaning yes — flagged.
7. **Interaction with the journal's existing incarnation fencing.** A replicated
   store's records ride a journal kind, which already has incarnation fencing (a
   rewind quarantines the stream). HLC is an ADDITIONAL order ON TOP. We must
   verify the two don't fight: an incarnation flip (whole-stream re-mint) should
   NOT reset the HLC order (HLC is record-level, monotone across incarnations).
   Believed compatible (HLC lives in `data`, incarnation in meta), but a named
   integration test is required (§12 — flagged for the test author).
