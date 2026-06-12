# Side-Effects Review — Durable Inbound Message Queue + Hold-for-Stability

**Version / slug:** `durable-inbound-message-queue`
**Date:** `2026-06-12`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent (required — gates dispatch + session lifecycle)`

## Summary of the change

Implements the converged + approved spec `docs/specs/durable-inbound-message-queue.md`
(CMT-1118, 10 convergence rounds): when the session-pool router cannot deliver an
inbound message right now (`queued`/`placement-blocked` verdicts that today fall
through to possibly-wrong-place local dispatch), the message is taken into durable
SQLite custody (`PendingInboundStore`, `synchronous=FULL`, 0600) and a drain engine
(`QueueDrainLoop`) delivers it when the blockage clears — with hold-for-stability
giving a suspect-but-alive owner up to `holdMaxMs` (90s) before its conversation is
re-placed. Ships DARK (`multiMachine.sessionPool.inboundQueue` enabled:false +
dryRun:true; hold trails one stage). Files: new `src/core/PendingInboundStore.ts`,
`QueueDrainLoop.ts`, `inboundQueueConfig.ts`, `inboundQueueBootSweep.ts`; edits to
`SessionRouter.ts`, `OwnerSuspectBreaker.ts`, `DeliverMessageHandler.ts`,
`MachinePoolRegistry.ts`, `BackupManager.ts`, `ConfigDefaults.ts`,
`devGatedFeatures.ts`, `guardManifest.ts`, `types.ts`, `TelegramAdapter.ts`,
`PostUpdateMigrator.ts`, `templates.ts`, `routes.ts`, `AgentServer.ts`,
`commands/server.ts`, `scripts/lint-guard-manifest.js`; four new test files
(unit ×4, integration ×1, e2e ×1).

## Decision-point inventory

- `SessionRouter.queueMessage` — modify — no-op → tri-state custody taking; router
  sets `acked` only for `queued`/`already-queued` (refused keeps today's un-acked
  fall-through).
- `Consumption site (server.ts onTopicMessage route consult)` — modify — adds the
  ordering gate, the custody-ack short-circuit, and the custody-aware route-throw
  point read; all three no-op when the engine is null (dark).
- `OwnerHoldVerdict (new)` — add — hold/failover/deliver at every
  `placeAndClaim('failover')` site; always-`failover` injected when the policy is
  off/dry-run (§4.2 effective-state honesty, /guards getter on the unconditional
  boot path).
- `DeliverMessageHandler.validateSender` — add — receive-side authz re-validation;
  typed non-retryable `sender-rejected` NACK; only consulted when an envelope is
  present (old peers unaffected).
- `Emergency-stop custody settle (TelegramAdapter.onSentinelStopCustody)` — add —
  stop transitions queued custody terminal + PIS cleanup; pause is engine-level
  (queued-rows-only freeze) and currently API-driven only (the sentinel 'pause'
  category still Escape-keys the session as before — unchanged behavior).
- `Boot sweep (runInboundQueueBootSweep)` — add — unconditional boot path, before
  `recoverPendingInjects`; gate-expires custody with named reasons; quarantines a
  corrupt store; vetoes PIS records for operator-stop rows ONLY.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The enqueue path can `refuse` legitimate messages at the caps (`maxPerSession` 50 /
`maxTotal` 500 / `hardMaxTotal` 1000 / oversize >64KB) — but a refusal is NEVER a
block: it maps to `acked:false` → today's exact local-dispatch fall-through, so the
worst case for a legitimate message is the pre-feature behavior (delivery, possibly
wrong-place, counted in `orderingViolations`). The `sender-rejected` NACK can reject
a sender deauthorized on the receiving machine but still authorized on the sender's
— per-machine registry divergence during a deauthorization window; the spec chose
the conservative side (the receive-side registry wins), the entry terminals
loss-REPORTED, and an old peer (no envelope) is never affected. The config-seam
validation refuses to START the queue on a violated invariant — deliberately
over-blocking the feature itself (OFF = today's behavior) rather than running
half-configured.

## 2. Under-block

**What failure modes does this still miss?**

The spec enumerates these as named windows: loss windows 1–6 (machine disk death;
crash instants around the receipt; restore-to-new-machine silent forfeit) and
duplicate windows 1–5 (PIS at-least-once replay instant; route-throw point-read
error fail-open; version-skew receipt boundary). None are silent — each is reported
or explicitly accepted in the spec with bounds. The hold verdict cannot detect a
hard-crashed machine faster than the heartbeat staleness window (one hold cycle of
added latency, named in spec §4.2). The §5.1 survivor arm only sees peers whose
last heartbeat carried depth fields (old/mesh-less peers are honestly unknown).

## 3. Level-of-abstraction fit

The custody store sits at the router verdict layer — the exact seam where the
no-op `queueMessage` already existed; it does not duplicate the ingress
exactly-once ledger (bypassed by design for drained entries — the receipt class is
the drain's own authority) nor the PendingRelayStore (outbound). The hold policy
feeds the EXISTING OwnerSuspectBreaker signals rather than adding a parallel
detector. The boot sweep lives on the unconditional boot path because the gated-off
states are exactly the ones whose components never construct (round-2/round-4
findings). No higher-layer gate exists that this should feed instead.

## 4. Signal vs authority compliance

Every decision is a deterministic policy evaluation over enumerable inputs (route
outcome enum, heartbeat liveness, breaker state, row state) — no brittle
pattern-matching holds blocking authority (`docs/signal-vs-authority.md`). The
fail direction is open-to-today's-behavior everywhere: storage failure → refused →
fall-through; point-read error → fall-through; invariant violation → queue OFF.
The flap detector and loss reports are signal-only (attention items, counters).
The one new blocking-shaped surface — `sender-rejected` — is an authz re-check
against the durable users registry (existing authority, new enforcement point),
not a new heuristic. Spec §Supervision documents the Tier-0
deterministic-evaluator carve-out; the 10-round convergence (including the
lessons-aware reviewer) audited exactly this question.

## 5. Interactions

- The ingress exactly-once ledger: custody COMPLETES the ledger row (the spec's
  §2.2 lifecycle); drained entries bypass the ledger gate by design — the
  injection receipt is a DISTINCT class, so no double-fire.
- PendingInjectStore: receipt-first ordering pinned (round-7); stop deletes PIS
  records; the boot sweep runs BEFORE `recoverPendingInjects` and vetoes
  operator-stop records only — the pause case deliberately does NOT veto.
- OwnerSuspectBreaker: `onClose` is additive; `recordSuccess` semantics unchanged.
- The reaper/respawn machinery: the drain reuses `respawnSessionForTopic` /
  `spawnSessionForTopic` WITH the `spawningTopics` guard, so drain and live spawns
  cannot race a duplicate spawn.
- Telegram dedup/confirmations: drain deliveries suppress the per-message
  "✓ Delivered" (the §3.1 contract) — no confirmation flood.
- Double-dispatch: the custody-ack short-circuit only fires when the enqueue
  COMMITTED (acked), and the route-throw catch point-reads the store — the
  enumerated residual is a point-read ERROR failing open (bounded duplicate,
  §5-enumerated).

## 6. External surfaces

- New Bearer-gated route `GET /pool/queue` (503 while dark). No payload content is
  ever served — counts, counters, tenure only.
- Mesh `deliverMessage` envelope gains optional `senderEnvelope`; `DeliverAck`
  gains `'sender-rejected'`. Old peers: never emit the new ack value, ignore the
  new field — both skew directions named in the spec.
- Capacity heartbeat gains the `inboundQueue` block (depth/oldest/tenure/topK) —
  additive, absent = unknown on old peers.
- CLAUDE.md template + `migrateClaudeMd` section (Agent Awareness + Migration
  Parity); ConfigDefaults delivers the dark config blocks to existing agents via
  the existing add-missing recursion (verified by test).
- The store file is excluded from backups via the unconditional
  `BLOCKED_PATH_PREFIXES` (restoring custody to a new machine would claim
  messages it never held).
- Timing/runtime dependence: drain behavior depends on heartbeat freshness and the
  breaker's suspect windows — exactly the dependencies the spec's hold-budget and
  clamp bounds were designed around.

## 7. Rollback cost

Feature is dark by default; nothing changes on deploy until an operator advances
the rollout. If wrong in production: flip `inboundQueue.enabled:false` (or
`dryRun:true`) + normal restart — the boot sweep gate-expires any residual custody
with named, loss-reported reasons (no silent stranding; flag semantics are
boot-read by design, spec §5.3). No data migration: the SQLite store is created on
first use and quarantine/prune paths bound its lifetime. The OFF-state is
byte-for-byte today's behavior except the one-shot residual sweep — verified by
the gate × behavior matrix tests. Worst-case backout is a hot-fix release deleting
the wiring; no agent state repair is ever needed (rows are per-machine,
self-expiring, backup-excluded).

## Known deliberate simplifications (named, not hidden)

- The §3.1 "extraction" is implemented as a drain-specific tail
  (`_drainLocalDeliver`) built from the same primitives as the live tail rather
  than relocating the live tail's 150 lines into a shared function — the live
  hot path is byte-untouched (zero regression risk), at the cost of two parallel
  tails to keep in sync. The drain tail enumerates every contract divergence in
  its comment block.
- The sentinel 'pause' category keeps its existing behavior (Escape key); the
  engine's pause/freeze surface (`onPause`/`onResume`) is fully built + tested
  but not yet bound to a user-facing trigger — binding it is a UX decision the
  operator should make with live dry-run data (the spec's §3.6 pause semantics
  are about WHEN frozen rows behave correctly, which is what ships).
- `custodyDurability` reports `'unknown'` (no fsync probe in v1) — the spec's
  round-8 field shipped as an honest placeholder rather than a guessed value.
- The §5.1 survivor re-placement uses empty-payload synthetic messages through
  `SessionRouter.forceReplace` (the router path, honoring pins + CAS) — "session
  recovery without message replay", exactly the spec's framing.

## Known deliberate simplifications — addendum after second-pass review

- Lease-acquisition tenure events: `onLeaseAcquired` is called once at engine
  construction (and `handoffInProgress` is unwired); per-acquisition tenure
  bumps + the §3.5 ordered-handoff enqueue gate are pre-promotion work, bounded
  meanwhile by the cross-boot clamp (`boot_session_id`) and the now-wired REAL
  `holdsLease` gate (a non-holder takes no custody at all, which closes the
  §2.2 exposure the reviewer named). <!-- tracked: CMT-1118 (rollout-criteria: dark→dev-dry-run gate; must land before dev-live promotion) -->

## Second-pass review

---

**Independent second-pass review (reviewer subagent, 2026-06-12):**

Verified against the implementation before raising concerns: MUST 1/3/4/6/7/9/10/11/12 are real — the conditional receipt is one transaction gated on the row still being `claimed` (`src/core/PendingInboundStore.ts`), the drain tail commits the receipt before the PIS record/inject and re-checks stop after it (`src/commands/server.ts` drain tail), the six config-seam invariants are checked at construction and a violation keeps the queue OFF with one loud error per inequality + an attention item, and the boot sweep runs on the unconditional path before `recoverPendingInjects`. The Q1/Q4 fail-open directions are real in code: storage throw → `refused`, null engine → `'refused'`, point-read error → fall-through. Dark-ship holds: all three consumption-site edits are inside the `_sessionRouter && _sessionPoolStage() !== 'dark'` block and additionally null-guarded on `_inboundQueue`; with the default config the engine is never constructed, `/pool/queue` 503s, and the only OFF-state delta is the named boot sweep (a no-op when no store file exists). `sender-rejected` is a registry re-check (existing authority), consulted only when an envelope is present; the hold verdict is a deterministic policy over enumerated inputs — no new brittle blocking authority. Backup exclusion, dev-gate registration, guard manifest, ConfigDefaults, migrator, and the test files all exist as claimed.

**Concern raised: the `no-mesh-identity` gate reason is never produced — a fully-enabled queue on a machine without mesh identity strands custody silently.** [...] produce the named gate-expiry (or fold the identity check into the sweep's gate) before live promotion.

**Concern raised: the dry-run rollout stage is structurally invisible — its evidence path is dead code.** [...] Either construct the engine in dry-run mode (it never claims custody by design) or name this in "Known deliberate simplifications".

**Concern raised: the lease gate is hardwired open and this simplification is not named.** [...] before live promotion either wire the real serving-lease signal (it exists — `leaseCoordinatorRef`) or add this to "Known deliberate simplifications".

**Concern raised (minor, latent): MUST 2's no-throw-after-commit is convention, not structure, at the engine layer.** [...] scoping the try to the `store.enqueue` call alone would make the invariant structural. No code change demanded for this dark ship; fix opportunistically.

Disposition: the dark-ship contract, fail-open directions, custody/receipt core, and signal-vs-authority compliance all check out in code. The four concerns are pre-promotion obligations (1–3) and a hardening note (4), not dark-deploy blockers.

**Author response (iterated per Phase 5, same session):** all four concerns ADDRESSED in code before commit —
1. no-mesh-identity: a one-shot 90s orphan-store backstop at the sweep site gate-expires + loss-reports custody whenever the swept store is never adopted by an engine (covers identity-missing AND construction-throw paths) — `server.ts` sweep block.
2. dry-run visibility: the engine now constructs in dry-run too (`qcfg.enabled` alone gates construction); the §2.4 counters accumulate and `/pool/queue` serves them — the promotion evidence is live.
3. lease gate: `holdsLease` wired to `leaseCoordinatorRef.holdsLease()` (single-machine no-coordinator defaults true); the remaining per-acquisition tenure-event wiring is the named tracked simplification above.
4. MUST 2: the refusal-mapping try now covers ONLY the store commit; post-commit bookkeeping throws are logged and can no longer convert a committed enqueue into `refused`.
