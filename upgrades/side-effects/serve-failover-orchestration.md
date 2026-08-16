# Side-Effects Review — Cross-Machine Serve-Failover Orchestration (§5.1 / §5.3 / §5.4 / §5A-stub)

Spec: `docs/specs/cross-machine-account-quota-sharing.md` (review-convergence + approved).
Scope (D16): the orchestration layer ONLY — per-account serveability signal, automatic
quota-aware seat-transfer failover, honest degradation, and a §5A detect→offer stub.
The §5A auto-enroll credential mechanism is DEFERRED behind WS5.2's build (not in this change).
Ships dark behind `subscriptionPool.serveFailover.{enabled,dryRun}` (live-on-dev / dark-on-fleet,
`dryRun:true` canary).

## Phase 1 — Principle check (signal vs authority)

This change has decision points; all are signal-side or consume EXISTING authority:
- `canServe` (§5.1) is an **advisory signal** (D8), carried in the heartbeat. It is NEVER a
  blocking authority — the destination's live admission-revalidation at seat-admission is the
  enforcement point (existing path), and a stale/lying advert is bounced, never a dead reply.
- Auto-failover (§5.3) consumes the **already-proven** `POST /pool/transfer` authority (signed
  mesh, recipient-bound, RBAC). The new code is a signal-driven TRIGGER + guards, not new
  blocking authority.
- Honest degradation (§5.4) emits a **notice** (signal to the user), not a block; D10 fail-open
  is conditioned on local serveability so a broken guard never strands a reply.
- §5A stub surfaces an attention **offer**; no authority, never blocks.
Conclusion: compliant — no brittle blocking authority added.

## The 8 questions

### 1. Over-block — what legitimate inputs does this reject that it shouldn't?
Nothing is "rejected." The only action is moving a SEAT to a peer that can serve, or emitting a
notice. Risk shape instead = an **unnecessary transfer** (a flappy account briefly reads
walled). Mitigated by D4 hysteresis: 60s min seat dwell, recovered-account debounce ≥2×
heartbeat, llm-circuit half-open damping (a single probe-success is not "recovered"), and a
per-source failover-rate cap. Dry-run canary logs intended transfers without performing them, so
the over-transfer rate is observable before `dryRun:false`.

### 2. Under-block — what failure modes does this still miss?
- A peer that adverts `canServe:true` but is actually walled by the time the seat lands → caught
  by D8 admission revalidation (destination bounces `cannot-serve` → next candidate → else §5.4).
- Whole-pool-walled → §5.4 honest degradation (no dead reply); episode closes on recovery-drain
  OR the durable-inbound-queue TTL loss-notice (both terminals named, D9/D13).
- The §5A in-place enrollment (making a walled machine serve from its OWN login) is NOT delivered
  here — it is the deferred WS5.2-dependent piece. Until then a persistently-walled machine's
  conversations are served by transfer to a peer (§5B); if NO peer can serve, §5.4 degrades
  honestly. This is the honest, bounded gap (documented in D16).

### 3. Level-of-abstraction fit
Correct layer. Serveability lives in the capacity heartbeat / `MachinePoolRegistry` (where peer
capacity already lives). Failover reuses the pool's `/pool/transfer` + `OwnershipApplier` rather
than inventing a parallel serve-routing path (Structure > Willpower). Degradation routes through
the existing dedup/attention/telegram notice path. No new primitive invented where one existed.

### 4. Signal vs authority compliance
Compliant — see Phase 1. `canServe` is advisory; admission-revalidation (existing) is authority;
the transfer authority is the proven `/pool/transfer`; degradation is a notice; fail-open is
local-serveability-conditioned (D10).

### 5. Interactions — shadowing / double-fire / races
- **Single-flight + per-dest cooldown** in the engine prevent double-firing a transfer for the
  same topic. Dwell/debounce prevent thrash with a recovering owner.
- Reuses `/pool/transfer`'s own idempotency/epoch-fencing; the failover trigger does not bypass
  it. D11 inherits the autonomous-run-suspend (`confirm:true`) so it never silently skips suspend.
- Honest-degradation notice is idempotent per (topic, walled-episode) with a coalescing window +
  ≥3-topic aggregation → does not double-voice or flood (Bounded Notification).
- Does not shadow the existing `quotaState.blocked` placement avoidance — `canServe` REFINES it
  (per-account, channel-aware) and is additive in the heartbeat.

### 6. External surfaces
- New read route `GET /serve-failover` (503 when dark) + `canServe` field on `GET /pool`. Both
  read-only; auth-gated; in `CapabilityIndex`.
- User-visible: the §5.4 honest-degradation notice (only when whole-pool-walled — replaces a dead
  "🔭 working…") and the §5A operator attention offer. Both are bounded/idempotent.
- Timing/runtime dependence: yes — it reads live heartbeat freshness + llm-circuit state. Handled
  by D8 revalidation (never trust a stale advert) and dry-run-first soak.

### 7. Multi-machine posture (Cross-Machine Coherence)
This feature IS the multi-machine layer. Postures:
- `canServe` signal — **replicated** via the existing capacity heartbeat / `PeerPresencePuller`
  advert (carried like `seamlessnessFlags`), proxied-on-read through `MachinePoolRegistry`.
- Failover transfer — rides the existing signed mesh `/pool/transfer` (reach ≠ authority; the
  carrier moves per-topic state incl. the authoritative operator binding, fenced by
  epoch/version, §5.3).
- Honest-degradation notice — one-voice gated (emitted only by the topic's owner/voice-holder),
  so no double-notice across machines.
- Single-machine install → the failover loop finds no peers and is a strict no-op; degradation
  only fires whole-pool-walled (= the one machine walled), which is the honest truth.

### 8. Rollback cost
Cheap. The whole layer is behind `subscriptionPool.serveFailover.{enabled,dryRun}`; on the fleet
it is dark (no-op). Back-out = set `enabled:false` (or it's already dark on fleet) — no data
migration, no state repair. The migration only ADDS the config default (existence-checked) and a
CLAUDE-template section; both are additive and reversible. `dryRun:true` is the default even
when enabled, so the first live exposure performs zero real transfers until deliberately flipped.

## Phase 4.5 — No-deferrals
The §5A auto-enroll credential mechanism and the literal credential-MOVE are deferred, but NOT
orphan-deferred: §5A is gated on the WS5.2 build (D16) and tracked by CMT-1568; credential-MOVE
is carved to its own named spec `cross-machine-credential-move` (D5). These are scope boundaries
of THIS converged spec, not partial-fix deferrals of the orchestration layer being shipped — the
orchestration layer (§5.1/§5.3/§5.4/§5A-stub) is COMPLETE in this change (3-tier tests, migration,
dark flag, observability all present).

## Phase 5 — Second-pass review
[appended by the reviewer subagent below]
