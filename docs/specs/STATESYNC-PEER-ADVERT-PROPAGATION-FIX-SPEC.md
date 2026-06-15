---
title: "Fix: peer stateSync receive-advert dropped → cross-machine memory replication never crosses"
slug: "statesync-peer-advert-propagation-fix"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "STATESYNC-PEER-ADVERT-PROPAGATION-FIX-SPEC.eli16.md"
status: "converged"
approved: true
approved-by: "operator pre-approval — Justin, topic 13481, 2026-06-14: decoupled build brief (.worktrees/echo-statesync-peer-advert-fix/BUILD-BRIEF.md) authorizing this fix end-to-end (build → PR → self-merge on green). Operator may revoke."
parent-spec: "docs/specs/multi-machine-replicated-store-foundation.md (§4 flag-coherence gate, the stateSyncReceive advert); the receive-side pass-through siblings this mirrors — commitmentsAdvert (#930), quotaState (#804/A2), preferencesAdvert (WS2.1)"
lessons-engaged:
  - "Distrust Temporary Success — A Recurrence Is a Root Cause: this is the FOURTH instance of one root cause (a narrowing receive-mapping that forgets a field). commitmentsAdvert (#930), quotaState (#804/A2), preferencesAdvert (WS2.1), now seamlessnessFlags. The fix ships a wiring-integrity ratchet so the CLASS cannot silently recur, not just a fourth patch."
  - "Cross-Machine Coherence: a peer's receive capability must actually cross the wire and SURVIVE the 30s sparse liveness beat, or the flag-coherence gate reads a false 'peer cannot receive' on both sides and blocks replication in BOTH directions — incoherence on the spatial axis."
  - "P4 Testing Integrity: three tiers — unit (pass-through + puller forward + registry carry-forward), integration (HTTP/mesh round-trip lands the peer's stateSyncReceive in /pool), wiring-integrity ratchet (every advert field is forwarded)."
  - "Name the Gravity Wells: 'the sender already emits it, so the receiver must too' is the false-symmetry trap — the receive mapping is a SEPARATE narrowing surface that silently omits new fields. The ratchet makes the omission loud."
dependency-gate:
  blocks: "Reuses the MERGED WS2 stateSync substrate: selfStateSyncReceive(), ReplicatedKindRegistry, checkPoolFlagCoherence, PeerStateSyncAdvert (src/core/ReplicatedRecordEnvelope.ts), MachineCapacity.seamlessnessFlags (src/core/types.ts:1946)."
  status: "SATISFIED — verified 2026-06-14: selfStateSyncReceive present (server.ts ~L3745); seamlessnessFlags built into the self heartbeat (server.ts ~L14071); fetchPeerCapacity + PeerPresencePuller + MachinePoolRegistry.recordHeartbeat are real exported/inline symbols on upstream/main @ v1.3.568."
  enforcement: "The wiring-integrity ratchet test asserts seamlessnessFlags is passed through fetchPeerCapacity's narrowing return AND forwarded by PeerPresencePuller.pullOnce → recordHeartbeat before the round-trip can land."
tracked-followups: "<!-- tracked: CMT-statesync-lightbeat-carryforward --> quotaState + inboundQueue share the SAME light-beat clobber latent in MachinePoolRegistry.recordHeartbeat, but both are FAIL-OPEN (absent = not-blocked / depth-unknown), so a transient wipe is benign — not carried forward here, the carry-forward is deliberately scoped to the fail-CLOSED seamlessnessFlags."
review-convergence: "2026-06-15T06:54:48.693Z"
review-iterations: 2
review-completed-at: "2026-06-15T06:54:48.693Z"
review-report: "docs/specs/reports/statesync-peer-advert-propagation-fix-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
cross-model-review-reason: "codex-cli gpt-5.5 + gemini-cli gemini-2.5-pro both ran on rounds 1+2; MINOR ISSUES, no material design findings"
---

# Fix: peer stateSync receive-advert dropped → cross-machine memory replication never crosses

## The bug (root-caused live on Laptop ↔ Mac Mini, 2026-06-14)

Cross-machine WS2 stateSync memory replication NEVER crosses machines. Proven on real
hardware: a learning written on the Laptop never reached the Mini. Each machine's own
`GET /pool` shows ITSELF with its full `seamlessnessFlags.stateSyncReceive` key set (7
enabled stores) but every PEER with **0** — i.e. each machine computes
`selfStateSyncReceive()` correctly for itself, but never SEES the peer's receive advert.

The boot-time `checkPoolFlagCoherence` (server.ts ~L14116) then reads each peer's
`stateSyncReceive` as absent → `peerAdvertisesStore(peer, store)` is false → the store is
classed MIXED → it logs "peer(s) cannot receive (would silently drop)" on BOTH sides. The
same gate, `shouldEmitToPeer` (ReplicatedRecordEnvelope.ts:613, substrate for the store-emit
PR), would withhold every emit for the same reason. Replication is blocked in BOTH directions.

## Root cause (exact) — a narrowing receive-mapping that forgets a field

The peer's capability IS emitted. The `session-status` mesh handler returns
`{ ...base, journalAdvert, ... }` where `base = machinePoolRegistry.getCapacity(meshSelfId)`
(server.ts ~L14752), and `MachinePoolRegistry.assemble` already includes
`seamlessnessFlags: live?.obs.seamlessnessFlags` (MachinePoolRegistry.ts:273). So the sender
emits `seamlessnessFlags` for free, exactly like `quotaState` and `guardPosture`. **No sender
change is needed** — confirmed by tracing `meshSelfId`/`poolSelfId` (both resolve from
`machineHeartbeat.config.machineId`) and `assemble`.

The field is DROPPED on the RECEIVE side, in **two** narrowing surfaces (the brief named one;
tracing the real path found the second):

1. **`fetchPeerCapacity` (server.ts ~L16073).** The inline `cap` type (~L16076–16084) omits
   `seamlessnessFlags`, and the narrowing `return {…}` (~L16095) never passes it through —
   sitting right next to the `quotaState`/`guardPosture`/`preferencesAdvert` pass-throughs
   that DO survive. This is the #930/A2/WS2.1 lesson, fourth instance.

2. **`PeerPresencePuller` (src/core/PeerPresencePuller.ts).** This is the intermediary between
   `fetchPeerCapacity` and the registry. Its `PeerCapacity` interface (L35–75) does not declare
   `seamlessnessFlags`; its `recordHeartbeat` dep signature (L97) does not accept it; and the
   `pullOnce` call (L179) forwards `quotaState` + `guardPosture` but not `seamlessnessFlags`. So
   even with site 1 fixed, the puller would still drop it before it reaches the registry.

3. **Light-beat clobber — `MachinePoolRegistry.recordHeartbeat` (MachinePoolRegistry.ts:184).**
   `recordHeartbeat` stores `obs` WHOLESALE (`this.observed.set(id, { …, obs, … })`, L205),
   carrying forward ONLY `posture` separately (L200–204). Two writers race on each peer entry
   every 30s: the rich `PeerPresencePuller.pullOnce` (server.ts ~L16183) and the SPARSE liveness
   echo in `refreshPool` (server.ts ~L14095: `recordHeartbeat({ machineId, selfReportedLastSeen })`).
   The sparse beat carries no `seamlessnessFlags`, so whenever it lands last it WIPES the pulled
   capability — making the fix flaky (works right after a pull, breaks 30s later). The durable fix
   must carry `seamlessnessFlags` forward on a beat that omits it, exactly as `posture` already does.

## The fix (three sites + an extracted mapping + ratchet)

### Site 1 — extract the receive-mapping, then pass `seamlessnessFlags` through (server.ts + PeerPresencePuller.ts)

The narrowing return inside `fetchPeerCapacity` is the recurring drop surface AND it is inline in
the server boot closure, which makes it impossible to unit-test directly and lets the integration
test only ever exercise a HAND-COPIED mirror of it (the existing `peer-presence-roundtrip.test.ts`
inlines its own `fetchPeerCapacity` that narrows away every advert field — testing the copy proves
nothing about production; convergence HIGH finding). The durable fix is to make the mapping a
single pure exported function, so production AND the test share one code path AND it is directly
ratchet-testable:

```ts
// src/core/PeerPresencePuller.ts (pure, exported)
export function narrowSessionStatusToPeerCapacity(
  raw: unknown,
  unwrappedJournalAdvert?: Record<string, { incarnation: string; lastSeq: number }>,
): PeerCapacity | null {
  if (!raw || typeof raw !== 'object') return null;
  const cap = raw as {
    selfReportedLastSeen?: string; loadAvg?: number;
    commitmentsAdvert?: { incarnation: string; replicationSeq: number };
    preferencesAdvert?: { incarnation: string; replicationSeq: number };
    quotaState?: { blocked: boolean; blockedUntil?: string; reason?: string };
    guardPosture?: import('./types.js').GuardPostureSummary;
    seamlessnessFlags?: import('./types.js').MachineCapacity['seamlessnessFlags'];
  };
  return {
    selfReportedLastSeen: cap.selfReportedLastSeen,
    loadAvg: cap.loadAvg,
    ...(unwrappedJournalAdvert ? { journalAdvert: unwrappedJournalAdvert } : {}),
    ...(cap.commitmentsAdvert ? { commitmentsAdvert: cap.commitmentsAdvert } : {}),
    ...(cap.preferencesAdvert ? { preferencesAdvert: cap.preferencesAdvert } : {}),
    ...(cap.quotaState ? { quotaState: cap.quotaState } : {}),
    ...(cap.guardPosture ? { guardPosture: cap.guardPosture } : {}),
    ...(cap.seamlessnessFlags ? { seamlessnessFlags: cap.seamlessnessFlags } : {}), // THE FIX
  };
}
```

`server.ts` `fetchPeerCapacity` keeps the closure-bound journal unwrap, then delegates the
narrowing: `const journalAdvert = _unwrapPeerJournalAdvert(machineId, (res.result as {...})
.journalAdvert); return narrowSessionStatusToPeerCapacity(res.result, journalAdvert);`. The
`seamlessnessFlags` object passes through WHOLE, so every current AND future flag key rides along.

This is a bounded, low-risk surface, not a re-architecture: `seamlessnessFlags` is a fixed-size
boolean summary from an Ed25519-AUTHENTICATED registered peer (the mesh envelope already proved
identity), stored as-is exactly like its `quotaState`/`guardPosture` siblings — no new validation
surface, no untrusted free-text into `/pool`.

### Site 2 — `PeerPresencePuller` interface + forward (PeerPresencePuller.ts)
- Add `seamlessnessFlags?: import('./types.js').MachineCapacity['seamlessnessFlags']` to the
  `PeerCapacity` interface (the helper above already returns it).
- Add the same optional field to the `recordHeartbeat` dep signature (L97).
- Forward it in the `pullOnce` `recordHeartbeat` call (L179):
  `...(cap.seamlessnessFlags ? { seamlessnessFlags: cap.seamlessnessFlags } : {})`.

### Site 3 — light-beat carry-forward (MachinePoolRegistry.ts)
In `recordHeartbeat`, when the incoming `obs` omits `seamlessnessFlags` but the previous obs has
it, carry it forward (mirroring the existing `posture` carry-forward):
```ts
const obsToStore = (obs.seamlessnessFlags === undefined && prev?.obs.seamlessnessFlags !== undefined)
  ? { ...obs, seamlessnessFlags: prev.obs.seamlessnessFlags }
  : obs;
this.observed.set(obs.machineId, { routerReceivedAtMs: nowMs, obs: obsToStore, skew: next, posture });
```
Update the `assemble` comment (MachinePoolRegistry.ts ~L270) that currently says "LIVE
observation only — no durable fallback": it remains memory-only (lost on restart, like posture's
in-memory half), but a light/liveness beat no longer erases the last pulled capability.

**Why carry-forward is safe (not a stuck-capability hazard):** a peer's GENUINE rich beat
(server.ts ~L14071) ALWAYS builds the `seamlessnessFlags` object — a withdrawn sub-capability
flips its boolean to `false` INSIDE a present object, it never OMITS the object. Omission happens
ONLY on the synthetic liveness echo (and on a pre-spec peer that never advertised, where there is
nothing to carry). So carry-forward preserves a real capability across our own synthetic beats and
never resurrects a genuinely withdrawn one. A peer that goes fully offline still ages out via
`routerReceivedAtMs` → `online: false`, which the coherence gate already filters on.

This "rich beat always builds the object" invariant is the carry-forward's load-bearing safety
assumption — so it is made EXECUTABLE (convergence: codex#2 / gemini#1 flagged it as a drift
risk). A unit test pins that the self heartbeat ALWAYS emits a present `seamlessnessFlags` object
including the ALL-DISABLED case (every flag `false`/empty, object still present), so a future
"omit empty flags" cleanup that would silently re-introduce the stale-capability hazard fails
loudly instead.

**Why field-specific carry-forward, not a generic deep-merge (rejected alternative):** a deep-merge
of every sparse beat onto prior obs (gemini's suggested generalization) would also carry STALE
`quotaState`/`inboundQueue` forward — a peer that CLEARED a quota block would keep looking blocked
to placement until its next rich pull, a real placement-behavior regression. The heartbeat's
existing `posture` carry-forward is already field-specific for exactly this reason; this fix
mirrors that established pattern and the build brief's "do not re-architect the heartbeat" scope.

### Ratchet — the real lesson from #930/#804/WS2.1 (behavioral, over real code)
Because the mapping is now an exported pure function, the ratchet is BEHAVIORAL (not brittle
source/string parsing — convergence: codex#3 / lessons-aware). To make "a NEW advert field added
without a pass-through fails loudly" a STRUCTURAL guarantee rather than a fixture that silently
omits unknown fields (convergence round 2, codex#1), the advert-field names are a single exported
registry shared by the fixture and the assertion:
```ts
// src/core/PeerPresencePuller.ts
export const SESSION_STATUS_ADVERT_FIELDS = [
  'journalAdvert', 'commitmentsAdvert', 'preferencesAdvert', 'quotaState',
  'guardPosture', 'seamlessnessFlags',
] as const;
```
A wiring-integrity test:
- Builds a FULLY-POPULATED session-status object whose advert keys are exactly
  `SESSION_STATUS_ADVERT_FIELDS`, runs it through `narrowSessionStatusToPeerCapacity`, and asserts
  EVERY field in the registry survives the narrowing — over the REAL production mapping the server
  calls. Adding a new advert field means adding it to the registry (the single touch-point), and
  the ratchet then covers it automatically; forget the pass-through and the test goes red.
- Asserts `PeerPresencePuller.pullOnce` forwards a fully-populated `PeerCapacity` to
  `recordHeartbeat` without dropping `seamlessnessFlags` (behavioral, the most durable form).

The pass-through guards in the helper use `field !== undefined` (presence), not truthiness
(convergence round 2, codex#2), so the "present even when all sub-flags are `false`/empty" invariant
can never be defeated by a future normalized-falsy representation.

## Tests (all three tiers — NON-NEGOTIABLE)

**Unit:**
- `MachinePoolRegistry.test.ts`: a rich beat with `seamlessnessFlags.stateSyncReceive` then a
  SPARSE `{ machineId, selfReportedLastSeen }` beat → `getCapacity` STILL returns the
  `stateSyncReceive` keys (carry-forward). A rich beat that flips a previously-present sub-flag to
  `false` inside a present object → withdrawal propagates (no false carry-forward). Correct for
  N ≥ 1 peers — each peer entry is an independent Map key; no pairwise/“exactly 2” assumption.
- `peer-presence-puller.test.ts`: `narrowSessionStatusToPeerCapacity` returning
  `seamlessnessFlags` → `pullOnce` → `recordHeartbeat` receives it. The behavioral ratchet: a
  fully-populated session-status → every advert field survives the narrowing (over the real
  helper). The full-capacity `PeerCapacity` → all forwarded by `pullOnce`.
- The invariant test: the self heartbeat builder ALWAYS emits a present `seamlessnessFlags`
  object, including the all-disabled case (locks the carry-forward safety assumption).

**Integration:**
- A real `/mesh/rpc` round-trip (extending `peer-presence-roundtrip.test.ts`): MINI records its
  own heartbeat WITH `seamlessnessFlags.stateSyncReceive`, serves `session-status`; LAPTOP's
  presence puller uses the SHARED `narrowSessionStatusToPeerCapacity` helper (the SAME code path
  production runs — not a hand-copied inline mock), so after ONE pass
  `laptopRegistry.getCapacity('MINI').seamlessnessFlags.stateSyncReceive` shows the keys (not
  0/absent). Then a subsequent SPARSE `recordHeartbeat({ machineId, selfReportedLastSeen })`
  asserts the keys SURVIVE (carry-forward proven end-to-end, not just in the unit layer).

**Wiring-integrity ratchet:** behavioral, over the exported helper — locks the CLASS shut.

## Out of scope (tracked)
`quotaState` + `inboundQueue` share the same light-beat clobber but are FAIL-OPEN (absent =
not-blocked / depth-unknown), so a transient wipe is benign; carry-forward is deliberately scoped
to the fail-CLOSED `seamlessnessFlags`. The MAXIMUM consequence of a transient `quotaState`
absence is bounded: for up to one ~30s beat interval, placement may route a session toward a peer
that is actually quota-blocked (it self-corrects on the next rich pull) — an inefficiency, never a
data-loss or correctness failure, which is why it does not warrant the same carry-forward here.
<!-- tracked: CMT-statesync-lightbeat-carryforward -->

## Convergence notes
- **Round 1 (internal multi-angle + external codex/gemini):** caught that the brief's "two edit
  sites" undercounts — the `PeerPresencePuller` intermediary (`PeerCapacity` interface +
  `recordHeartbeat` dep + L179 call) is a THIRD drop site between `fetchPeerCapacity` and the
  registry; without it, site-1 alone is a no-op. Confirmed the SENDER already emits via `base`
  (getCapacity(self).assemble), so no sender change is needed — narrowing the diff. The
  integration reviewer surfaced a HIGH finding: the existing `peer-presence-roundtrip.test.ts`
  inlines its OWN `fetchPeerCapacity` that narrows away every advert field, so extending it would
  prove nothing about the production fix. External codex/gemini both flagged the carry-forward's
  "rich beat always builds the object" invariant as a drift risk, and the ratchet's
  source/string-parsing form as brittle; gemini proposed a generic deep-merge.
- **Round 2 (folded all material findings; re-reviewed externally):** (a) EXTRACTED the receive
  mapping into the pure exported `narrowSessionStatusToPeerCapacity` so production and the
  integration test share ONE code path (closes the HIGH fidelity gap) and the ratchet is
  behavioral over real code (closes codex#3); (b) made the "rich beat always builds the object"
  invariant EXECUTABLE via a unit test (closes codex#2/gemini#1 drift risk); (c) REJECTED the
  generic deep-merge with a documented reason (it would strand stale fail-open `quotaState`,
  regressing placement; the heartbeat's `posture` carry-forward is already field-specific) and
  kept the scoped carry-forward; (d) added the post-sparse-beat carry-forward assertion to the
  integration test, the bounded-authenticated-data note (codex#1), the N ≥ 1 correctness note, and
  the `quotaState` max-consequence bound (codex#4). No material design issues remained — the
  changes are clarifications/test-hardening of an unchanged core design, so convergence holds.
- **Round 2 external re-review (codex/gemini on the converged body):** both returned MINOR ISSUES,
  no new material design findings. Folded two cheap structural improvements: a shared exported
  `SESSION_STATUS_ADVERT_FIELDS` registry so the ratchet genuinely covers a future field rather
  than a fixture that silently omits it (codex#1), and `!== undefined` presence guards instead of
  truthiness in the new helper (codex#2). REJECTED with rationale: gemini's "separate liveness vs
  state channels" and "distinct Rich/Sparse observation types" are larger re-architectures
  explicitly out of scope per the build brief ("do not re-architect the heartbeat") — and the fix
  deliberately mirrors the EXISTING `posture` carry-forward pattern; the behavioral invariant test
  is the pragmatic guarantee in place of the type-system one. Noted as possible future hardening,
  not a blocker. CONVERGED.
