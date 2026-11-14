# Side-Effects Review — Chief of Staff records are stored agent-wide

**Version / slug:** `cos-store-agent-wide`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `not required (no gate, sentinel or delivery decision changed; see 4)`

## Summary of the change

Tier 1. 2 source files (about 20 added lines), 1 test file extended. One build pass, no spec rounds.

Echo Bugs topic 10000002562. The Chief of Staff (dev-gated, docs/specs/chief-of-staff-topic.md) keeps all of its state — the owner's check-ins (renewals), project bindings, notes, last-tick records — as `chief-of-staff-record` entries written through the shared `ReplicatedRecordEmitter`. That emitter refuses any store whose `stateSync[store].enabled` is not `true`. The spec (§1.2) says "the `multiMachine.stateSync.chiefOfStaff` flag is forced on whenever `chiefOfStaff.enabled` is true", but nothing ever set it: no default, no migration, no forced-on entry in the resolved stores map. So every record was refused with outcome `disabled` on every machine (Studio log: `[chief-of-staff] note record not accepted (disabled)` every 15 minutes), the operator lease never had a renewal to fold, and Justin's 18:16 UTC check-in in topic 141385 counted on no machine. The loop stayed paused whichever machine served the topic.

Changes:
- `src/core/ChiefOfStaffStore.ts`: `chiefOfStaffStoreEnabled(config)` = `resolveDevAgentGate(config.chiefOfStaff?.enabled, config)` — the same switch the feature wiring uses.
- `src/commands/server.ts`: `_stateSyncStoresResolved` adds `chiefOfStaff: { enabled: true }` when that switch is on, the same pattern as `topicPins`, `appConversations` and `topicClaimAnnotations`. The emitter and the receive advert (`selfStateSyncReceive`) both read this map, so a machine with the feature on now writes, advertises and receives the kind.

## Decision-point inventory

None changed. The emitter's dark gate is unchanged; this only supplies the flag the spec already required. The Chief of Staff's own decisions (owner-only inbound, lease liveness, action protocol) are untouched.

## 1. Over-block

No issue identified. Nothing is refused that was accepted before; records that were refused are now accepted.

## 2. Under-block

The feature switch itself still follows `developmentAgent`, which is machine-local config. On Echo the Mama PC is not marked a development agent, so the loop is not wired there (`GET /chief-of-staff` → 503 "not enabled on this agent"). If the serving lease moved to that machine, the Chief of Staff would go quiet there. That is a per-machine config split, a separate class (the dev-agent flag is not agent-wide), filed as a follow-up in topic 10000002562 <!-- tracked: topic 10000002562 -->.

## 3. Level-of-abstraction fit

Right layer: the resolved stores map at boot is where every other forced-on store (topicPins, appConversations, readMarkers, topicClaimAnnotations, subscriptionAccountMeta) is set. A config default would not work alone because `resolveStateSyncStores` only resolves keys present in config and the spec wants it forced on, not operator-optional.

## 4. Signal vs authority compliance

No blocking authority added. Reference: docs/signal-vs-authority.md. The change removes an accidental refusal.

## 4b. Judgment-point check

No new heuristic.

## 5. Interactions

- Records now persist, so the loop's durable behaviour that was silently inert becomes live on development agents: the root tree node is written once, note cadence is durable (no more "holding the cadence in memory"), `last-tick` records feed the §2.1 grace tick, and an owner check-in makes the lease live for 72 h. With a live lease and bound projects the loop may restart a stalled project — the designed behaviour, still behind the dev gate and the verified-owner gate. Echo has 0 bound projects today.
- The emitter's per-kind rate cap and the journal's never-delete retention for this kind (8 MB rotation) are unchanged; volume is about one last-tick per 15 minutes plus notes and renewals.
- Peers that do not advertise the store (older version, or feature off) are not forwarded the kind — the existing flag-coherence rule.

## 6. External surfaces

Development agents only (fleet stays dark: the switch defaults off). The visible effect is that a check-in in the Chief of Staff conversation now starts it.

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated, through the existing `chief-of-staff-record` journal kind and the peer stream reader the loop's `loadUnion` already merges. This change is what makes that posture real: before it the posture was "nothing stored anywhere". Renewals are signed per machine and verified on read with the peer's mesh key (unchanged).

## 8. Rollback cost

Revert the commit; records already written stay in the journal and are ignored by a reverted build's emitter only for new writes (the fold still reads them, which is harmless: they are the owner's real check-ins). No migration, no state repair.

## Conclusion

Ship. Smallest change that makes the Chief of Staff's state agent-wide, as its spec already required.

## Second-pass review (if required)

Not required: no messaging block/allow, session lifecycle, gate or watchdog logic changed.

## Evidence pointers

- `tests/unit/chief-of-staff-store-wiring.test.ts` section 4: the switch resolution; server.ts forces the store on in the map the emitter reads; the real `ReplicatedRecordEmitter` + `CoherenceJournal` refuse a renewal with the pre-fix map (`disabled`) and store it with the fixed map (one `renewal` row read back from the journal).
- Why the existing tests missed it: `tests/e2e/chief-of-staff-alive.test.ts` builds its own emitter with `stores: () => ({ chiefOfStaff: { enabled: true } })`, so it proved the store works when on, never that the server turns it on. The new section-4 source assertion pins the server's map.
- Live: Studio `logs/server.log` 2026-11-11 16:56–20:11 UTC, `note record not accepted (disabled)` each tick; `GET /chief-of-staff` on Studio and Mini both `renewedAt: null` after the 18:16 check-in.

## Class-Closure Declaration (display-only mirror)

Runtime wiring defect (a spec-required flag never set). The same shape — a kind emitted through the shared emitter with no default and no forced-on stateSync entry — was checked for every store in the `ReplicatedStoreReconcilerWiring` allowlist against `ConfigDefaults` and the resolved-map block in server.ts. Every store has one or the other except two: `workingSetArtifact` (default off by design, documented at its call site) and `contextLayers`, whose own rollout says "dark until stateSync is on" (PR #3037/#3043, Phase 0/1 of context-budget-layered-summaries) and which Echo's `/context-budget/layers` reports as `disabled: 1`. That one is a staged rollout owned by the context-budget effort, not this defect, and is named for that effort in topic 10000002562 <!-- tracked: topic 10000002562 -->.
