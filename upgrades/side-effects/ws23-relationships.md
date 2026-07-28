# Side-Effects Review — WS2.3 relationships (first PII replicated store)

**Version / slug:** `ws23-relationships`
**Author:** `echo`
**Second-pass reviewer:** `not required (dark-ship, observe-only until flag flip)`
**Spec:** `docs/specs/ws23-relationships-userregistry-security.md` (converged + approved, CMT-1413)

## Summary of the change

Wire the relationship registry (`RelationshipManager`, `relationships/<id>.json`) onto
the HLC replicated-store foundation as the SECOND concrete consumer and the FIRST PII
kind, `relationship-record`. New module `src/core/RelationshipsReplicatedStore.ts` holds
the strict typed schema (discriminated union on `op` for value + tombstone, with
per-field type-clamps), the disclosure-minimized projection, the channel-set identity
recordKey derivation, the HIGH impact tier, per-kind bounds, the 64KB per-entry cap,
the tombstone builder, the union-aware read, and the foreign-record render-safety
helper. `relationship-record` is registered in BOTH `JOURNAL_KINDS` (CoherenceJournal —
static half) AND `ReplicatedKindRegistry` (dynamic half). `RelationshipManager` gains
two injected, dark-by-default seams: a replication emitter (a `put` on the save funnel,
a channel-keyed `op:'delete'` tombstone on delete/merge) and a union-read seam (the
read-only neutralized peer-context surface). Ships DARK
(`multiMachine.stateSync.relationships { enabled:false, dryRun:true }`).

## Decision-point inventory

1. **recordKey = channel-set identity surface, NOT the local UUID (REQ-D17).** The on-disk
   `id` is per-machine; the same human has different UUIDs on different machines, so the
   replicated key is a deterministic `sha256(sorted(channel-uids))`. This is the
   single most load-bearing identity decision; it is documented in the module and proven
   by the recordKey tests (same person → same key regardless of order; disjoint people →
   different keys; channel-less → null, not replicable).
2. **64KB per-entry cap (REQ-M3 gap #10).** A fat relationship exceeds the default 8KB
   applier cap; raised to 64KB so the highest-PII records replicate, with a NAMED
   over-cap rejection (`RelationshipRecordTooLargeError`) rather than silent truncate or
   suspect-wedge.
3. **mergeRelationships put+delete coherence (the sharp edge).** A local merge emits a
   survivor `put` (now carrying the consolidated channel set) AND a tombstone keyed on
   the merged record's OLD standalone channel set. The two recordKeys are DISTINCT (the
   survivor subsumes the merged's channels), so the tombstone can never suppress the
   survivor — no dangling tombstone, no replication loop. Proven by the merge test.
4. **Slice (CMT-1416).** Only `relationship-record` ships here; user-registry +
   topic-operator are a tracked follow-up on the proven machinery.

## 1. Over-block

**What legitimate inputs does this change reject?** The receive-side schema rejects a
foreign record with a non-ISO-8601 `firstInteraction`/`lastInteraction`, a non-number
`interactionCount`/`significance`, a missing/empty `name`, a bad channel, or > MAX_CHANNELS
channels — all malformed-data rejections at the RECEIVE door (a peer's replicated
record), never a user-initiated local action. A local `findOrCreate`/`updateNotes`/… is
unaffected (it goes through the normal save path; the emit is best-effort AFTER the
durable local write and swallows its own failures). With the flag OFF (default), nothing
is emitted, validated, or read through the union: strict no-op — NO PII ever crosses a
machine boundary.

## 2. Under-block

**What does this still miss?** The `loadOriginRecords` seam reads only the OWN
relationship store today — peer `relationship-record` replicas land via the journal
apply path in a later rollout stage (the same staging as WS2.1's shipped reference). So
on a single-machine / pre-apply agent the union is a no-op (just the local record); the
union / conflict / append-both / tombstone-wins logic is fully exercised by unit tests
against synthetic multi-origin inputs and through the real `ReplicatedStoreReader`. The
spec's deeper PII obligations beyond this slice (operator-mandate-gated destructive
local delete on receive, the deferred-erasure queue, the merge-skew gate, AAD binding)
are tracked in the converged spec and ride later increments; this PR establishes the
schema/projection/recordKey/tombstone/cap machinery they build on. The at-rest
plaintext-rest exposure delta is the operator-accepted residual (REQ-A2) stated honestly
in the CLAUDE.md awareness section.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The new kind rides the existing foundation primitives
(ReplicatedRecordEnvelope / UnionReader / ConflictStore / RollbackUnmerge /
ReplicationBudget) — no foundation change beyond registering the kind in the dual
registry. The bypass-proof read goes through `ReplicatedStoreReader` (the single
funnel). The PII-specific concerns (the channel-set recordKey, the type-clamp schema,
the disclosure-minimized projection, the tombstone, the untrusted-data render envelope)
live in one module. The emit/read seams on `RelationshipManager` are injected so the
manager stays pure-testable and dark by default.

## 4. Reversibility

Fully reversible. The whole feature is dark behind
`multiMachine.stateSync.relationships` (default `enabled:false`). Disabling it is a
strict no-op (no emission, no union read, no peer view). A peer's contribution rolls
back via the existing RollbackUnmerge (`/state/quarantine`). No destructive operation is
introduced in THIS slice: the emit funnel only adds a best-effort `put`/tombstone
AFTER the durable local write; it never blocks or alters a local mutation, and a
throwing emitter cannot break a local write (proven). The destructive-local-delete-on-
receive (mandate-gated) is explicitly OUT of this slice.

## 5. Migration / fleet-rollout surface

- **Config:** `multiMachine.stateSync.relationships { enabled:false, dryRun:true }` added
  to `ConfigDefaults` — `applyDefaults` add-missing backfills existing agents (Migration
  Parity; no bespoke migrateConfig block needed). Classified in `DARK_GATE_EXCLUSIONS`
  (optional-integration); the hand-authored dark-gate line-map was recomputed via the
  attributor (regeneration forbidden) and the new `relationships.enabled` path + the +14
  shift below it hand-edited.
- **CLAUDE.md awareness:** the existing "One Memory (replicated stores)" section gains a
  WS2.3 relationships-consumer line (WITH the at-rest PII honesty note) in BOTH
  `generateClaudeMd` (new agents) and `migrateClaudeMd` (existing agents, via an
  idempotent content-sniff splicer guarded by the unique "Relationships are the FIRST PII
  store" marker). The framework shadow markers already cover the section (both `**` and
  `### ` variants), so Codex/Gemini parity is inherited.
- **Dual-registry CI ratchet:** the `ReplicatedRecordEnvelope.test.ts` coupling test +
  the new wiring test assert `relationship-record` is coupled in both registries — a
  future edit removing it from `JOURNAL_KINDS` would RED.

## Adversarial review (5 lenses — PII-grade)

Total findings: **3 real, 3 folded** (0 deferred).

1. **Injection / type-clamp completeness** — FINDING (folded): the `firstInteraction`/
   `lastInteraction` fields render UNSANITIZED in `getContextForPerson`, so a foreign
   record could smuggle markup through them. Folded: the schema validates them as
   ISO-8601-only (rejecting any string with `<`/`>`/`"` or a non-date), and the foreign
   render path additionally escapes every field inside the untrusted-data envelope —
   two independent defenses. Proven by `injection-neutralized-firstInteraction` +
   `schema-type-clamp`.
2. **Disclosure minimization** — FINDING (folded): the local UUID `id` must never leave
   the machine. Folded: it is absent from `RELATIONSHIP_STORE_KNOWN_FIELDS` and the
   projection builder never emits it; the `disclosure-minimization` test asserts every
   emitted field is in the allowlist and `id` is absent.
3. **Tombstone / erasure correctness** — FINDING (folded): `mergeRelationships` could
   emit a tombstone that suppresses the survivor (the merged channels are now part of
   the survivor). Folded: the tombstone keys on the merged's OLD standalone channel set,
   whose recordKey is DISTINCT from the survivor's consolidated recordKey — proven by
   the merge test (distinct keys) and the union test (`erasure-reaches-offline-peer`,
   tombstone-wins-over-stale-value). No dangling tombstone, no loop.
4. **recordKey identity derivation** — no real finding: same channel set → same key
   (order-independent); disjoint sets → different keys; the same person with different
   UUIDs → same key. Collision requires the EXACT same full channel set, which is the
   manager's own definition of "the same person". Proven by the recordKey tests.
5. **Flag-coherence PII-leak prevention** — no real finding: emission is gated on
   `isStoreEmissionEnabled` + the per-peer `shouldEmitToPeer` advertise check (foundation
   machinery, REQ-M5); a dark agent never emits, and a peer that does not advertise
   `relationships` is never a forward target. The advert self-reports from registry
   presence + the enabled flag. (Live serve/pull transport is the later rollout stage,
   gated by the same flag; THIS slice keeps PII strictly local until the operator flips
   the flag.)

## Verdict

Safe to ship dark. Zero behavior change — and zero PII egress — for any agent until an
operator flips `multiMachine.stateSync.relationships.enabled`. The channel-set recordKey,
the type-clamped discriminated-union schema, the disclosure-minimized projection, the
channel-keyed tombstone, and the untrusted-data render envelope are the load-bearing PII
correctness properties and are each proven by a named test.
