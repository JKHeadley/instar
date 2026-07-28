# Side-Effects Review — The Agent Carries the Loop (agent-owned-followthrough, C1+C2)

**Version / slug:** `agent-owned-followthrough`
**Date:** 2026-06-14
**Author:** echo
**Second-pass reviewer:** required (touches PromiseBeacon / MessagingToneGate / reconciler auto-close) — see Phase 5 appendix.

## Summary of the change

Implements C1+C2 of the "The Agent Carries the Loop" spec (converged + operator-ratified 2026-06-14): a commitment is the agent's obligation to act, never the user's to remember; the user is pinged only for a result or a genuine authorization. Adds an `owner` ⟂ `blockedOn` state model to `Commitment` (`CommitmentTracker.ts`) with `record()`/`transitionState()` well-formedness gates + `loadStore()` back-fill; an owner-gated outbound chokepoint `PromiseBeacon.emitUserSend()` (suppresses agent-owned status sends, reroutes terminal failures to the Attention dead-letter); an external-block staleness governor (`sweepExternalBlocks()`) + `POST /commitments/:id/probe` + absolute ceiling; an evidence-gated graveyard reconciler (`reconcileGraveyard()`); a guarded `POST /commitments/:id/transition` route; a `commitments-sync` receive enum-clamp (`CommitmentsSync.applyPage`); two signal-only detectors (`parked-on-user.ts`, `internal-id-leak.ts`) feeding new `MessagingToneGate` rules B19/B20 + a beacon-local B-IDLEAK pass; server wiring of the `agentOwnedFollowthrough` resolver into `PromiseBeacon` (developmentAgent gate, sweeps lease-gated); config defaults + dev-gate registry entry + `migrateClaudeMd`/`generateClaudeMd` + the ratified constitution article. Ships dark-on-fleet / live-in-dryRun-on-dev.

## Decision-point inventory

- `MessagingToneGate` B19_PARKED_ON_USER / B20_INTERNAL_ID_LEAK — **add** — signal-driven LLM-authority rules; the brittle detectors only flag.
- `CommitmentTracker.record()/transitionState()` owner/blockedOn well-formedness gates — **add** — structural validation (enum + named-authorization), never semantic prose classification.
- `PromiseBeacon.emitUserSend()` owner-gate — **add** — suppresses agent-owned status / reroutes terminal; rollout-gated (no-op when off).
- External-block staleness governor + reconciler auto-close — **add** — mutating sweeps, lease-gated + feature-gated + dry-run-first.
- `external-operation-gate` (tool-call side-effect authority) — **pass-through, unchanged** — explicitly NOT modified by C1+C2 (its hardening is the C3 follow-on).

---

## 1. Over-block

The two new gate rules are signal-only and favor false-negatives (fail toward sending). **B19 over-block risk:** a legitimate "your call" on a genuine value/taste/spend decision (the human-only set) — explicitly carved out in the rule (do NOT apply when the deferred thing is the user's decision, or is an authorization ask). **B20 over-block risk:** a direct answer to a user who asked for an identifier — carved out (do NOT apply when the user explicitly asked). The owner-gate (`emitUserSend`) only suppresses for `owner:'agent'` commitments AND only when the feature is enabled+live; `owner:'user'` and feature-off always send. No user-facing message is hard-blocked by this change — the gate authority decides with carve-outs, and beacon suppression only drops *agent-owned status pings the user is not supposed to get*.

## 2. Under-block

B19/B20 are brittle regex signals — trivially reworded to evade (e.g. "I'll let you handle the restart" dodges the B-PARK phrase list). This is acceptable: they are SIGNALS, not the authority, and the spec is explicit they are a mitigation, not a complete fix. The owner-gate misses a genuinely-stuck `owner:'agent'` commitment only if the agent mis-declares its state — but the single covering invariant + the §4.4 window dead-letter + the §4.5 reconciler ensure no agent-owned non-terminal commitment stays silent past a bound. B20 does NOT replace `redactSecrets`/`guardProxyOutput` (real secret/path disclosure stays enforced by those).

## 3. Level-of-abstraction fit

Correct. The detectors (`parked-on-user`, `internal-id-leak`) are low-level brittle SIGNALS; `MessagingToneGate` (the existing full-context LLM) is the AUTHORITY (B19/B20 combine signal + conversational context, with carve-outs). The owner-gate lives INSIDE `PromiseBeacon` (not the tone gate) precisely because beacon sends are `isProxy:true` and bypass the gate. The reconciler reuses the existing `verify()`/`isUnverifiableOneTime` scar machinery rather than re-implementing closure. The ratchet's authority (C3) is deliberately NOT built here — the existing tool-call `external-operation-gate` is the unchanged side-effect authority.

## 4. Signal vs authority compliance

**Reference:** docs/signal-vs-authority.md

- [x] **No — this change produces a signal consumed by an existing smart gate.** B19/B20 are signal-driven rules; the brittle `parked-on-user`/`internal-id-leak` detectors flag, the full-context `MessagingToneGate` LLM decides (with carve-outs, fail-toward-sending). The `record()` well-formedness gates are structural (enum validity + named-authorization presence) — a deterministic well-formedness check at the right layer (the store), mirroring the operator-binding "blank uid refused" pattern, never a semantic judgment. The owner-gate suppression is a routing decision on the agent's OWN status output (not a user-message block), gated by the feature flag. No brittle logic holds user-message block authority.

## 5. Interactions

- **Shadowing:** the owner-gate sits at the beacon's send sites (after the existing snapshot/atRisk/liveness logic); it suppresses the send for `owner:'agent'` but does not shadow `verify()` or the escalation ladder (rung3 still surfaces). B20 is additive to the existing jargon/file-path signals (does not shadow `redactSecrets`).
- **Double-fire:** the governor + reconciler share the beacon's slow sweep timer (lease-gated, one machine) — they don't race the 60s `verify()` sweep. The governor dedupes via `externalBlockDeadLetteredAt`; the reconciler is bounded by `maxClosesPerPass`.
- **Existing tests:** beacon (90+), tone-gate (36), CommitmentsSync (17), ConfigDefaults (52), dev-gate wiring (52), feature-completeness (99) all stay green — the feature-off default preserves current behavior byte-for-byte.

## 6. External surfaces

New HTTP routes: `POST /commitments/:id/probe`, `POST /commitments/:id/transition` (Bearer-auth, cross-machine routed like `/deliver`). New `Commitment` fields ride the existing `commitments-sync` replication (enum-clamped on receive). The dead-letter reuses the existing `raiseAttention` Attention surface (HIGH-priority, deduped). Mobile-Complete: the user-facing surfaces are an Attention item + plain Telegram messages — phone-complete; no operator CLI/file step introduced. Operator-Surface-Quality: the dead-letter is plain English ("I've been waiting on … want me to keep waiting or drop it?"), no raw internals.

## 7. Multi-machine posture (Cross-Machine Coherence)

- `owner`/`blockedOn`/`actionClass`/`lastProbe`/`supersededBy` — **replicated** via the existing `commitments-sync` mesh path (additive on `extends Commitment`), **enum-clamped on receive** (`CommitmentsSync.applyPage`, defaults agent/none). Replicated rows are advisory, never authoritative.
- The governor + reconciler sweeps — **machine-local execution, lease-gated** (`holdsLease` via `leaseCoordinatorRef`): only the lease-holder runs the mutating sweep, so no cross-machine double-dead-letter / double-close. Single-machine → always runs (safe no-op gate).
- The probe/transition routes — **proxied to the owning machine** (mirror `/deliver`'s `resolveCommitmentRoute`/`forwardMutation`, new cross-machine `probe`/`transition` ops on `CommitmentMutateOp` + `MeshRpc`).
- User-facing notices ride the beacon's existing one-voice speakerElection gate.

## 8. Rollback cost

Cheap. Ships dark-on-fleet (the developmentAgent gate resolves `enabled` false for the fleet) and live-in-dryRun-on-dev (`dryRun` defaults true → the owner-gate/governor/reconciler LOG what they would do but suppress/mutate nothing). Off-switch: set `commitments.agentOwnedFollowthrough.enabled: false` (or leave the gate's fleet default). A bad behavioral interaction is reverted by flipping `enabled` off (config, no code revert) or `dryRun: true`. No data migration to undo — the new `Commitment` fields are additive/optional and back-filled idempotently; turning the feature off leaves them inert. No destructive credential/state action anywhere in C1+C2.

---

## Phase 5 — Second-pass review verdict

**Concur with the review.** An independent reviewer verified all six load-bearing safety properties against the actual code (not the artifact's claims):
1. Signal-vs-Authority — the detectors hold zero block authority; B19/B20 are LLM-gate rules (fail-open, favor false-negatives); the owner-gate suppresses only the agent's own `isProxy` status sends, never a user-message block.
2. The reconciler closes ONLY on `supersededBy`→terminal-success; no time/"abandoned" auto-close branch exists (CMT-1101 scar intact).
3. `emitUserSend` reroutes terminal failures to `raiseAttention` (never swallowed); rollout-gated (off/owner:user → unchanged; dryRun → still sends).
4. The governor + reconciler sweeps are lease-gated (`holdsLease()`) AND feature-gated (off → no-op; dryRun → no mutation/dead-letter).
5. Genuinely dark-on-fleet / live-in-dryRun-on-dev (`resolveDevAgentGate` + dryRun default true); feature-off path is byte-for-byte prior behavior.
6. `external-operation-gate` is NOT in the C1+C2 change set — its fail-posture is unchanged (the hardening is the C3 follow-on).

**Non-blocking observation (carried to the C3 follow-on, CMT-1505):** the `CommitmentsSync` receive clamp covers `owner`/`blockedOn` (the routing-significant enums) but not `actionClass`/`lastProbe` — both inert/non-authoritative in C1+C2, so no exploitable branch today; clamp them when `actionClass` becomes load-bearing in the ratchet build.
