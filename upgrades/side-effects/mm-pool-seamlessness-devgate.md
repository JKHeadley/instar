# Side-Effects — multiMachine.seamlessness coherence flags → dev-gated (topic 13481), sessionPool master HELD

**Change (PR2 of the no-dark-on-dev multi-machine directive):** Re-gate the 5
`multiMachine.seamlessness` coherence flags — `ws3OneVoice` (one-voice election),
`ws13Reconcile` (ownership reconcile), `ws41DurableAck` (durable cross-machine /ack),
`ws43RoleGuard` (role-guard-at-spawn), `ws43JournalLease` (journal-lease cutover) — from
hardcoded `false` in `ConfigDefaults.ts` to the developmentAgent gate (live-on-dev /
dark-fleet), mirroring the merged `ws44PoolLinks` / `ws44PoolCache` precedent. The
`ws43JournalLeaseDryRun` sub-knob is computed COHERENTLY with its gate (dev → live/false,
fleet → dry-run/true). **The `multiMachine.sessionPool.*` master switch and its
`inboundQueue` / `holdForStability` sub-flags are deliberately HELD** (see #7).

**Driver:** Operator directive (Justin, topic 13481, 2026-06-13): "NOTHING should ship
dark on development agents. Everything fully functional so it actually gets tested and
doesn't just rot." PR1 (#1151) moved the 7 stateSync memory stores; PR2 is the remaining
dark-on-dev multi-machine seamlessness layers.

**Spec:** `docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md` (the converged + approved spec the
seamlessness flags were built against) + `docs/specs/multi-machine-replicated-store-
foundation.md` (sessionPool context). This is a follow-up gating fix to already-merged
features, not a new feature.

## What was wrong

The 5 seamlessness flags shipped with a literal `false` in `ConfigDefaults.ts` (e.g.
`ws3OneVoice: false`). A written literal force-darks even a development agent (the #1001
anti-pattern), so the coherence layers never ran ANYWHERE — they could never be dogfooded
on Echo / the Mini and never graduated toward the fleet. ws44PoolLinks/ws44PoolCache had
already been corrected to the omitted-gate pattern; these five lagged behind.

## What changed

- `src/config/ConfigDefaults.ts` — OMIT the hardcoded `false` for all 5 flags (each carries
  a ws44-style "DELIBERATELY OMITTED" comment) so `resolveDevAgentGate` decides at runtime.
  `ws43JournalLeaseDryRun` is ALSO omitted (computed coherently at the consumer). `ws13DryRun`
  stays a plain hardcoded default `true` (it is the in-component "log intended CAS without
  performing it" rung, NOT the dev-gate). The sessionPool block is UNTOUCHED.
- `src/commands/server.ts` — route each consumer read through `resolveDevAgentGate(...)`:
  - `ws3OneVoice`: `SpeakerElection.enabled` → `resolveDevAgentGate(ws3Cfg().ws3OneVoice, config)`.
  - `ws13Reconcile`: `OwnershipReconciler.enabled` → gated; `dryRun` stays the plain `ws13DryRun !== false` read.
  - `ws43RoleGuard`: `scheduler.setRoleGuard().enabled` → gated.
  - `ws43JournalLease`: `setJournalLeaseCutover().enabled` → gated; `dryRun` →
    `cfg?.ws43JournalLeaseDryRun ?? !resolveDevAgentGate(undefined, config)` (coherent).
  - the heartbeat `seamlessnessFlags` advert resolves journal-lease via the gate, not the raw read.
- `src/server/routes.ts` — `ws41DurableAckEnabled()` reads through
  `resolveDevAgentGate(..., ctx.config)`, so the route + precedence guard agree.
- `src/core/devGatedFeatures.ts` — ADD all 5 flags as `DEV_GATED_FEATURES` entries
  (by-name, each with a non-destructive/no-egress justification). A header comment records
  WHY the sessionPool master + sub-flags are NOT moved here (the StageAdvancer stage-gate).
- `src/core/PostUpdateMigrator.ts` — NEW `migrateConfigSeamlessnessDevGate(config)`: strips
  a default-shaped `false` per flag (and the paired `ws43JournalLeaseDryRun:true` only
  alongside a default-shaped `ws43JournalLease:false`) so the gate resolves on update. An
  operator-set value (explicit `true`, a divergent dryRun) is left ENTIRELY alone. Idempotent.
  Wired into the migrate path with `upgraded`/`skipped` reporting.
- `tests/unit/lint-dev-agent-dark-gate.test.ts` — EXPECTED attribution map line numbers
  recomputed via the attributor (the 5 removed literals + comment reflow shift sessionPool
  786→809 and cartographer 1100→1123). The 3 sessionPool flags STAY in the map (held,
  hardcoded false). No paths added/removed (the seamlessness flags were never `enabled:`-named).

## Decision-point inventory (Phase-4)

### 1. Over-block
A gate that resolved live when it shouldn't. Not possible: `resolveDevAgentGate` resolves
true ONLY when `developmentAgent: true` (or an explicit `true`), so the fleet is byte-for-byte
unchanged. Each layer is additionally a strict single-machine no-op (the election never
engages below 2 online machines; the role-guard never fires when this machine holds the lease;
the journal-lease cutover requires ≥2 flag-coherent peers).

### 2. Under-block
A consumer left on the raw `=== true` read would keep the feature DARK on a dev agent even
though ConfigDefaults omits it (the PR1 "still-dark-on-dev = incomplete" failure). Closed by
grepping ALL consumer sites (5 flags + the heartbeat advert + the dryRun coherence formula)
and routing every one through the gate, then pinning it with a source-string no-missed-consumer
wiring test (`tests/unit/seamlessness-dev-gate-wiring.test.ts`, section B) that fails CI if a
consumer reverts to the raw read.

### 3. Level-of-abstraction fit
The gate is resolved at the SAME construction/route boundary as the ws44 precedent — one
funnel (`resolveDevAgentGate`) reads the raw config value and the agent's `developmentAgent`
flag. No new abstraction; the consumers' downstream `enabled`-true semantics are unchanged.

### 4. Signal vs authority compliance
Each layer runs in the SAFE direction and none gains authority from going live-on-dev:
ws3OneVoice only WITHHOLDS a duplicate send (never fabricates one); ws13Reconcile runs in its
own dry-run (logs intended CAS, performs none); ws43RoleGuard can only REFUSE a spawn (never
wrongly spawn); ws41DurableAck persists an intent bound to the AUTHENTICATED operator and the
owner REVALIDATES at apply time; ws43JournalLease coordinates job claims over durable state
and the cutover gate guarantees the two mechanisms are never both live for a job set.

### 5. Interactions
- ws43JournalLease ↔ ws43JournalLeaseDryRun: the two MUST resolve coherently or a dev agent
  would run live-but-dry-run (logged, never exercised) — handled by the `?? !resolveDevAgentGate`
  formula at the consumer AND the migration's paired strip.
- The heartbeat `seamlessnessFlags.ws43JournalLease` advert (what peers read to decide
  coherence) now mirrors the resolved enabled+not-dry-run, so a dev agent honestly advertises
  the capability to a peer.
- sessionPool HELD: because the seamlessness flags have NO stage-gate, they are independent of
  the sessionPool master — flipping them live-on-dev does not activate the (held) session pool.

### 6. External surfaces
None new. The five features' routes/behaviors already existed; this only changes WHICH agents
resolve them live. Replication/coordination is between the operator's OWN machines — no
external egress, no third-party spend, no new API.

### 7. Rollback cost & multi-machine posture (the heart)
- **Rollback:** trivial and per-flag — set an explicit `multiMachine.seamlessness.<flag>: false`
  in `.instar/config.json` to force-dark even a dev agent; an explicit `true` is the fleet-flip.
  No data migration to undo (these are coordination layers, not stores). The 3 sessionPool flags
  need no rollback — they were never flipped.
- **Multi-machine posture:** these layers EXIST to make the operator's two machines behave as
  one agent. Live-on-dev means Echo (laptop) + the Mac Mini now genuinely exercise one-voice
  election, ownership reconcile, durable cross-machine acks, the spawn-time role-guard, and the
  journal-lease cutover across the real two-machine mesh — the only way they get tested before
  fleet. A single-machine dev agent is a strict no-op for all five (no peers).
- **sessionPool HELD — the deliberate exception:** `multiMachine.sessionPool.{enabled,
  inboundQueue.enabled, holdForStability.enabled}` were NOT moved to dev-gated. They share a
  SECOND, structurally-enforced gate: `sessionPool.stage` is **StageAdvancer-write-only** (a
  module-private `STAGE_WRITE_TOKEN`, rejected by `stageWriteGuard.ts` for any other writer),
  defaults to `'dark'`, and advances only through an E2E-gated rollout ladder
  (`dark → shadow → live-transfer → rebalance`). The activation expression EVERYWHERE is
  `enabled && stage !== 'dark'` (server.ts:1990, 1998, 14351, 15611; boot-sweep gate 7019-7024).
  So: (a) dev-gating `enabled` alone leaves the pool INERT on a dev agent (`stage` is still
  dark) — a hollow move that fails the directive's "actually gets tested"; and (b) forcing
  `stage` past dark in ConfigDefaults would BYPASS the deliberate cutover discipline the
  StageAdvancer exists to enforce — not a clean, safe-by-default, reversible change. This is a
  genuine collision between the "nothing dark on dev" directive and an explicit structural
  safety invariant, so it is surfaced to the operator rather than forced. **Operator decision
  needed:** advance `sessionPool.stage` on the dev mesh via the StageAdvancer ladder (gated on
  green E2E) if active-active pooling should be dogfooded live; until then it stays dark.

## Migration parity

`applyDefaults` is add-missing-only deep-merge, so a new agent gets the omitted-flag shape via
`init`. Existing agents that received the old `false` literals would keep them (explicit values
are not overwritten) and stay dark even on a dev agent — so `migrateConfigSeamlessnessDevGate`
strips the exact default-shaped `false` (and paired dryRun) on update. An operator's hand-edited
value is never touched (reach is not authority). Idempotent (a second run strips nothing).

## Tests

Unit: `seamlessness-dev-gate-wiring` (13 — resolution + no-missed-consumer source-seam +
registry coherence), `PostUpdateMigrator-seamlessnessDevGate` (9), `lint-dev-agent-dark-gate`
(line-map recomputed), `devGatedFeatures-wiring` (74), `feature-delivery-completeness` (99),
`SpeakerElection` / `OwnershipReconciler` / `ws3-one-voice-wiring`. Integration/E2E: the
existing `scheduler-role-guard`, `scheduler-journal-lease-cutover`, `attention-remote-ack`
suites stay green; `attention-remote-ack-alive` E2E gains two dev-gate cases (flag OMITTED +
developmentAgent:true → route ALIVE; fleet → 503) proving the gate flips the route, not just
the registry. Typecheck clean (`tsc --noEmit` exit 0); full lint suite clean. The full suite is
left to CI (the authority).
