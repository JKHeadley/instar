# Side-Effects Review — WS2.1 preferences replicated store

**Version / slug:** `ws21-preferences-replicated-store`
**Author:** `echo`
**Second-pass reviewer:** `not required`
**Spec:** `docs/specs/multi-machine-replicated-store-foundation.md` (converged + approved)

## Summary of the change

Wire the auto-learned preference store (`PreferencesManager`, `.instar/preferences.json`)
onto the HLC replicated-store foundation as the FIRST concrete `pref-record` replicated
kind. A preference learned on one machine is honored on the others — read through the
no-clobber union with operator-resolved conflicts. New module
`src/core/PreferencesReplicatedStore.ts` holds the store schema, impact tier (high),
per-kind bounds, the emit-envelope builder, and the load-bearing union-aware read
(`mergeUnionToPreferences` / `buildUnionSessionContext`). `pref-record` is registered in
BOTH `JOURNAL_KINDS` (CoherenceJournal — static half) AND `ReplicatedKindRegistry`
(dynamic half). The `/preferences/session-context` route consults a wired
`ReplicatedStoreReader` ONLY when `multiMachine.stateSync.preferences.enabled`. Ships
DARK (`enabled:false`, `dryRun:true`).

## Decision-point inventory

1. **Impact-tier resolution (spec §15.1):** preferences are HIGH-impact at the
   replication layer (append-both-and-flag), but the consumer read injects BOTH
   variants as advisory hints on an open conflict — never blocking. Decision recorded
   in the build prompt + the spec; the conservative side (never silently clobber).
2. **Coordination with the legacy PreferencesSync (CMT-1416):** the foundation path
   SUPERSEDES the seamlessness path; both ship dark → zero runtime duplication. The
   route gives the foundation path precedence when its flag is on.

## 1. Over-block

**What legitimate inputs does this change reject?** The pref-record store schema
rejects a record with an empty `learning` or a path-shaped `provenance` (the §4 jail).
Both are malformed-data rejections at the RECEIVE door (a replicated record from a
peer), never a user-initiated action — a local `recordPreference` is unaffected. With
the flag OFF (the default), nothing is emitted, validated, or read through the union:
strict no-op, byte-identical single-machine behavior. The route's foundation branch is
gated on `stateSync.preferences.enabled` so a dark agent keeps its exact legacy read.

## 2. Under-block

**What does this still miss?** The `loadOriginRecords` seam reads only the OWN
preference store today — peer `pref-record` replicas land via the journal apply path in
a later rollout stage. So on a single-machine / pre-apply agent the union is a no-op
(just the local record). This is the honest dark-ship boundary, not a gap: the union /
conflict / both-variants logic is fully exercised by unit tests against synthetic
multi-origin inputs. The `dryRun` mode (log intended merges without mutating) is the
config ladder's middle rung; the emit/apply transport wiring is gated by the same flag.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The new kind rides the existing foundation primitives
(ReplicatedRecordEnvelope / UnionReader / ConflictStore / RollbackUnmerge /
ReplicationBudget / StoreSnapshot) — no foundation change beyond registering the kind in
the dual registry. The bypass-proof read goes through `ReplicatedStoreReader` (the
single funnel), so no caller can read the raw store around the no-clobber rule. The
consumer-specific concerns (the dedupeKey↔recordKey mapping, the local-only
`violationPattern` strip, the both-variants reconciliation) live in one module.

## 4. Reversibility

Fully reversible. The whole feature is dark behind `multiMachine.stateSync.preferences`
(default `enabled:false`). Disabling it is a strict no-op (the route keeps its legacy
path; no emission, no union read). A peer's contribution can be rolled back via the
existing RollbackUnmerge (`/state/quarantine`), which the foundation already wires. No
destructive operation is introduced; the conflict ledger + dropped-origins set are the
foundation's existing durable state under `.instar/state/state-sync/`.

## 5. Migration / fleet-rollout surface

- **Config:** `multiMachine.stateSync.preferences { enabled:false, dryRun:true }` added
  to `ConfigDefaults` — `applyDefaults` add-missing backfills existing agents on update
  (Migration Parity; no bespoke migrateConfig block needed). Classified in
  `DARK_GATE_EXCLUSIONS` (optional-integration, staged rollout) so the literal
  `enabled:false` is accounted for by the dark-gate lint.
- **CLAUDE.md awareness:** the existing "One Memory (replicated stores)" section gains a
  WS2.1 preferences-consumer line in BOTH `generateClaudeMd` (new agents) and
  `migrateClaudeMd` (existing agents, via an idempotent content-sniff splicer guarded by
  the unique "Preferences are the FIRST live store" marker).
- **Dual-registry CI ratchet:** the `ReplicatedRecordEnvelope.test.ts` coupling test now
  asserts `pref-record` is coupled in both registries — a future edit removing it from
  `JOURNAL_KINDS` would RED.

## Verdict

Safe to ship dark. Zero behavior change for any agent until an operator flips
`multiMachine.stateSync.preferences.enabled`. The advisory both-variants read is the
load-bearing correctness property and is proven by a §12 wiring test (an open conflict
never suppresses a usable hint).
