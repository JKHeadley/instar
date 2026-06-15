# Side-Effects Review — Fix: peer stateSync receive-advert dropped → cross-machine memory replication never crosses

**Version / slug:** `statesync-peer-advert-propagation-fix`
**Date:** `2026-06-15`
**Author:** `echo`
**Second-pass reviewer:** `echo (independent reviewer subagent — Phase 5; touches a coherence gate's input)`
**Spec:** `docs/specs/STATESYNC-PEER-ADVERT-PROPAGATION-FIX-SPEC.md` (review-convergence + approved; codex/gemini external passes)
**Parent principle:** Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions

## Summary of the change

A peer's `seamlessnessFlags` advert (the carrier of `stateSyncReceive` — which replicated
kinds a machine can durably receive) was emitted by the sender but DROPPED on the receive
side, so the flag-coherence gate read every peer as "cannot receive" and blocked
cross-machine replication in both directions (root-caused live Laptop↔Mini, 2026-06-14).
Three receive-side files: `src/core/PeerPresencePuller.ts` (new exported pure helper
`narrowSessionStatusToPeerCapacity` + `PeerCapacity` field + `recordHeartbeat` dep +
`pullOnce` forward + `SESSION_STATUS_ADVERT_FIELDS` registry), `src/commands/server.ts`
(`fetchPeerCapacity` delegates to the shared helper), `src/core/MachinePoolRegistry.ts`
(`recordHeartbeat` carries `seamlessnessFlags` forward on a beat that omits it). No new
decision point — this FEEDS the existing `checkPoolFlagCoherence` / `shouldEmitToPeer` gate
with the data it was missing.

## Decision-point inventory

- `checkPoolFlagCoherence` / `shouldEmitToPeer` (`src/core/ReplicatedRecordEnvelope.ts`) — **pass-through (feeds, does not modify)** — the gate already exists and already reads `peer.stateSyncReceive`; this change makes that field actually arrive. No gate logic changed.
- `MachinePoolRegistry.recordHeartbeat` carry-forward — **modify (data retention)** — carries the last pulled `seamlessnessFlags` across a beat that omits it; not a block/allow decision, a freshness-of-observation rule mirroring the existing `guardPosture` carry-forward.
- `narrowSessionStatusToPeerCapacity` — **add (pure data-narrowing helper, no decision logic)** — extracted from the inline `fetchPeerCapacity` so production + tests share one mapping.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface is added. The change REMOVES an unintended over-block: before it, a
peer that was genuinely receive-capable was treated as not, so legitimate replication was
withheld. The carry-forward never fabricates capability where none was pulled (the "no prior
pull → sparse beat does not fabricate" unit test pins this), so it cannot over-advertise.

## 2. Under-block

**What failure modes does this still miss?**

`quotaState` and `inboundQueue` ride the same light-beat clobber and are NOT carry-forwarded
here — but both are fail-open (absent = not-blocked / depth-unknown), so a transient wipe is
benign (bounded to ~one 30s beat, self-correcting on the next rich pull). Scoping the
carry-forward to the fail-CLOSED `seamlessnessFlags` is deliberate; the fail-open siblings are
tracked (`<!-- tracked: CMT-statesync-lightbeat-carryforward -->`). A genuinely offline peer
still ages out of `online` via `routerReceivedAtMs`, so a stale carried advert is never acted
on as a live one.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The narrowing belongs in the receive mapping (`PeerPresencePuller`), the carry-forward
belongs in the registry that owns the per-machine observation (`MachinePoolRegistry`, beside
the identical `guardPosture` carry-forward), and the gate that consumes the advert
(`ReplicatedRecordEnvelope`) is untouched. Extracting the inline narrowing into a shared pure
helper raises a hard-to-test closure into a unit-testable function — the correct layer for the
regression guard the recurring bug class demands.

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic, or feed a smart gate?**

It FEEDS. The change adds no blocking authority. The flag-coherence gate
(`checkPoolFlagCoherence` / `shouldEmitToPeer`) is the existing authority; this change only
delivers the peer-advert signal it was already designed to read. Per
`docs/signal-vs-authority.md`, this is a signal-delivery fix, not a new gate. The helper is a
pure data map; the carry-forward is a freshness rule, not a decision.

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, race?**

Two writers race on each peer's registry entry every 30s: the rich `PeerPresencePuller.pullOnce`
and the sparse `refreshPool` liveness echo. Before the fix the sparse beat clobbered the rich
advert; the carry-forward resolves that race deterministically (omission → keep prior). It does
NOT shadow `guardPosture` (separate field, separate carry-forward) or `quotaState` (intentionally
still clears). The shared helper means `server.ts:fetchPeerCapacity` and the round-trip test can
never drift apart (the gap that let this bug hide from the existing test).

## 6. External surfaces

**Does it change anything visible to other agents/users/systems?**

`GET /pool` now shows each peer's real `seamlessnessFlags.stateSyncReceive` instead of an empty
0 — a more-correct read, no schema change (the field was already in the `MachineCapacity` type
and the assemble output; it was simply always undefined for peers). No new route, no new MeshRpc
verb. The peer advert is fixed-size booleans from an Ed25519-authenticated registered peer,
stored as-is exactly like its `quotaState`/`guardPosture` siblings — no new untrusted surface.
Old peers that never advertise are treated as non-participants (the conservative side), unchanged.

## 7. Multi-machine posture (Cross-Machine Coherence)

This change IS the cross-machine path. Posture: **replicated-capability advert** — the peer's
receive capability crosses via the existing signed `session-status` mesh pull and is recorded
per-peer in `MachinePoolRegistry`. Correct for N ≥ 1 peers: `checkPoolFlagCoherence` iterates all
online peers with no pairwise/"exactly 2" assumption; each peer is an independent registry Map
entry (pinned by the per-peer carry-forward unit test). No LAN assumption, no broadcast. No
user-facing notice, no durable-state-on-transfer, no generated URL involved.

## 8. Rollback cost

Low. Pure runtime code fix in three files, no config/schema/migration. Back-out is a plain
revert of the commit — the prior behavior (peers read as non-receiving, replication withheld)
is the safe-but-broken state this fixes, so reverting cannot cause data loss, only re-disable
the (default-off) replication path. No data migration, no agent-state repair.

---

## Second-pass review

**Concur with the review.** Independent reviewer audited the artifact against the actual
`git diff src/ tests/` and verified: (1) no new gate/block logic — `ReplicatedRecordEnvelope.ts`
untouched, the change only feeds the existing flag-coherence gate; (2) the carry-forward in
`MachinePoolRegistry.recordHeartbeat` is correctly scoped to `seamlessnessFlags` only and does
not alter `quotaState`/`guardPosture`/`inboundQueue` handling (`quotaState` still clears on a
sparse beat); (3) the shared helper uses `!== undefined` presence guards so an all-disabled
`{ stateSyncReceive: {} }` survives, and preserves all six advert fields with the same shape as
the old inline mapping (none dropped or added); (4) `server.ts` preserves the `journalAdvert`
unwrap (computed locally with `machineId` context, then passed to the helper and re-emitted
unconditionally, identical to the old inline return). No missed side effect identified.
