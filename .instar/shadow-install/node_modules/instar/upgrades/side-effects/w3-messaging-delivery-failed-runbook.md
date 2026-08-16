# Side-Effects Review — W-3: messaging-delivery-failed runbook + DeliveryRetryManager.runRecoveryCycle

**Version / slug:** `w3-messaging-delivery-failed-runbook`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Ships Tier-2 wrapper W-3 per `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §A1 (W-3 row), §A6 (structured provenance), §A9 (durable verify), §A21 (verify outcome taxonomy), §A34 R3 (surface-alignment correction — new `runRecoveryCycle()` public method distinct from timer-driven `tick()`), §A36 (essential validator), §A57 (Tier-2 W-3).

Two new modules / extensions:

- `src/remediation/runbooks/messaging-delivery-failed.ts` — the runbook. Matches structured-provenance events with `errorCode ∈ {DELIVERY_FAILURE, TELEGRAM_429, TELEGRAM_500}` and `provenance ∈ {subsystem-explicit, probe-id}` (per §A6: explicitly NO `free-text`). surfaceCallable delegates to `DeliveryRetryManager.invokeFromRemediator`. verify() queries the durable on-disk inbox and asserts ALL queued/undelivered messages have drained per §A9 (not just "the cycle ran"). priority 80; blastRadius `process`; essential `false` per §A36 (essential=true would require blastRadius='machine').
- `src/messaging/DeliveryRetryManager.ts` (extended) — adds `runRecoveryCycle()` and `invokeFromRemediator(ctx)` as additive public methods per §A34 R3. The existing timer-driven `tick()` is unchanged in behavior but now wraps a shared `cycleInFlight` latch so two concurrent callers (e.g. timer + Remediator) cannot double-process the inbox. The latch is a single-process boundary; cross-process exclusion remains the Remediator MachineLock's job. `tick()`'s return shape is unchanged except for an optional `skipped: true` marker when the second caller short-circuits.

Files touched:
- `src/remediation/runbooks/messaging-delivery-failed.ts` (new)
- `src/messaging/DeliveryRetryManager.ts` (extended — runRecoveryCycle + invokeFromRemediator + shared latch)
- `tests/unit/runbooks/messaging-delivery-failed.test.ts` (new — 16 cases)
- `tests/unit/DeliveryRetryManager-runRecoveryCycle.test.ts` (new — 11 cases)
- `upgrades/NEXT.md` (W-3 entry added; existing F-1..F-7, F-8, W-1, scheduler, drift-classifier entries preserved verbatim)
- `upgrades/side-effects/w3-messaging-delivery-failed-runbook.md` (this artifact)

## Decision-point inventory

- `messagingDeliveryFailedRunbook.match(event)` — **add** — narrow filter: returns true only when `event.subsystem ∈ {messaging, delivery-retry}`. Pure structural equality; no LLM, no regex over free-form text.
- `messagingDeliveryFailedRunbook.preconditions(event)` — **add** — `_deps` wired AND `getManager()` returns non-null. Refuses to fire when messaging is not initialized (e.g. unit-test boot or pre-server-up).
- `messagingDeliveryFailedRunbook.verify(ctx)` — **add** — opens an inbox query against the wired `MessageStore` and counts queued/undelivered messages. Returns one of three §A21 outcomes; in particular probe error (queryInbox throws) → verify-inconclusive, not verify-failed.
- `DeliveryRetryManager.runRecoveryCycle()` — **add** — Remediator-orchestrated parallel entry point. Idempotent against the running timer via `cycleInFlight` latch.
- `DeliveryRetryManager.invokeFromRemediator(ctx)` — **add** — surface entry-point. Wraps `runRecoveryCycle` and returns `ExecutionResult` with structured details (retried/expired/escalated/skipped).
- `DeliveryRetryManager.tick()` — **modify** (wrap) — now acquires the same `cycleInFlight` latch as `runRecoveryCycle`. Inner body extracted unchanged into `doCycle()`. No behavior change for existing callers; the optional `skipped` field is additive.
- `setMessagingDeliveryDeps(deps)` — **add** — production wires the live manager + store; tests inject fakes. Setting to `null` puts the runbook into a "deps unwired" state where surface/verify return inconclusive.

The legacy `tick()` entry-point and the `start()` timer are **pass-through** (existing behavior preserved). The shared latch means a 15s timer tick and a Remediator-dispatch arriving in the same ~ms window won't double-sweep the inbox — first caller wins, second short-circuits with `skipped: true`. This is the §A34 R3 invariant.

No new HTTP routes. No new persistent files. The runbook module exports `setMessagingDeliveryDeps` for late-binding so the messaging singleton doesn't need to be imported at module-load time (avoids a circular import path through the server). Production wiring of `setMessagingDeliveryDeps` is deferred to a separate Tier-2 PR alongside `DegradationReporter.setRemediator()` — this PR ships the unit-testable surface only, matching how W-1 left `NativeModuleHealer.invokeFromRemediator` constructible-but-unwired.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **Free-text-provenance delivery failures** are NOT matched by this runbook. This is by design (§A6). Legacy `.report(...)` callers in `src/messaging/` that normalize to `provenance: 'free-text'` cannot trigger the recovery cycle — they route to `no-matching-runbook` and feed NovelFailureReviewer's clustering pipeline. Operators who hit delivery failures via the timer cadence STILL get retries because the 15s `tick()` cadence is unchanged. The structural defense costs no functionality.
- **Events about non-messaging subsystems** are rejected by `match()`. Intended — `DeliveryRetryManager` only knows how to drain its own message store. A different subsystem's delivery failure (e.g. webhook delivery, if that subsystem existed) would need its own runbook.
- **Events arriving while a tick is mid-flight** are returned `skipped: true` and produce zero work via this dispatch. NOT a rejection — the in-flight cycle WILL sweep the same inbox, so the work is not lost. The Remediator's `verify-failed` taxonomy correctly reports "drain succeeded" or "drain incomplete" regardless of which entry-point did the sweep.

No legitimate input is rejected that should have been accepted.

---

## 2. Under-block

**What failure modes does this still miss?**

- **No cross-process deduplication.** Two agent processes on the same machine racing the same on-disk inbox would each acquire the shared latch within their OWN process and proceed; cross-process exclusion is the Remediator's MachineLock job (F-4). This runbook is layered on top of that — the in-process latch is the second line of defense, not the first. The single-agent-per-stateDir invariant (already enforced by the agent server's lifeline lock) makes the cross-process race extremely narrow in practice.
- **Verify counts queued + undelivered only.** Messages in `delivered` phase awaiting ACK timeout are not counted as "stuck" for §A9 purposes. Intended — Layer 3 ACK timeouts are NOT a delivery failure; they're an upstream agent-not-responding signal. A `verified-healthy` result here means delivery has been re-attempted; it does NOT mean every message has been ACKed.
- **No deadline enforcement on verify() separately.** The Remediator's §A4 AbortController fires around the whole `surfaceCallable + verify` chain (60s budget per `expectedRuntimeMs`). The verify probe is a single on-disk inbox read; under load it stays well under that budget.
- **`runRecoveryCycle` does not pre-empt mid-flight on `ctx.abortSignal`.** The cycle body is a loop over inbox entries with short, atomic store operations per entry. We don't check the abort signal mid-loop. Acceptable because: the deadline is 60s, each iteration is a single fs read + fs write, and pre-empting mid-iteration could leave the retryState map inconsistent. If the deadline trips, the dispatcher's `aborted-deadline` branch supersedes whatever we return anyway.
- **The shared latch is not fair.** If a tick is in-flight and 20 Remediator dispatches arrive in 200ms, all 20 short-circuit with `skipped: true` and the single in-flight cycle handles every message. Acceptable — the inbox is a shared queue, "drain everything you can" is idempotent across callers.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. Each piece sits where the spec mandates:

- **Runbook (`src/remediation/runbooks/messaging-delivery-failed.ts`)** is the policy layer — declares the match contract, verify semantics, blast-radius, and surfaceCallable wiring. Pure data plus a thin verify wrapper; no orchestration, no key material, no audit-write concerns.
- **`DeliveryRetryManager.invokeFromRemediator`** is the surface layer — owns translating `RemediationContext` into a recovery cycle invocation, returning structured `ExecutionResult` details. No knowledge of the Remediator's lock / intent / audit primitives.
- **`DeliveryRetryManager.runRecoveryCycle`** is the operation layer — owns the §A34 R3 "idempotent against running timer" rule via the shared latch. Independent of who called it.
- **Verify helper (`probeDurableDrain`)** is the durability probe — owns the §A9 "assert durable, not just live" rule. Cleanly separated from the recovery step so verify can run independently.

No higher-level smart gate is shadowed. The Remediator's `registerRunbook()` validator (§A6, §A36) is the gate that accepts/rejects this runbook at boot; the runbook itself doesn't contain blocking authority beyond the structural match contract.

The signal-vs-authority principle (`docs/signal-vs-authority.md`) is honoured: the match is precise structural code (errorCode enum membership + provenance enum membership + subsystem string equality), not a heuristic content classifier. The authority to "trigger a recovery cycle" is the manager's own; the runbook merely calls into it.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no brittle-logic blocking authority. Match is precise structural code over enum-typed fields; verify is a deterministic on-disk inbox count; the only block surface (§A36 essential-on-machine) is enforced by the F-8 dispatcher's validator, not by this runbook.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The runbook's structural decisions:
- §A6 prefilter (errorCode + provenance enum equality) — precise.
- §A36 essential=false enforced by F-8 validator (no claim to essential here).
- §A9 verify (queued + undelivered count == 0) — deterministic.
- §A34 R3 idempotence (single-process latch, first-wins) — deterministic.
- §A21 verify taxonomy — derived from inbox-count probe result kind.

No brittle string-matching, no LLM judgement, no content classifier. The match callback's subsystem string equality is the same shape as W-1's better-sqlite3 narrowing.

---

## 5. Interactions

**What other components is this change touching, even indirectly?**

- **F-8 dispatcher (`Remediator.dispatch`)** — registers and dispatches this runbook. Existing dispatch path is generic; no modification needed. The dispatcher's §A6 / §A36 validators accept the runbook (verified by unit test).
- **F-3 `DegradationReporter`** — emit-sites in `src/messaging/` will eventually call the structured emit helper to produce DELIVERY_FAILURE / TELEGRAM_429 / TELEGRAM_500 events with `provenance: 'subsystem-explicit'`. The migration is incremental; until then, legacy callers route to `no-matching-runbook` via `provenance: 'free-text'` (intended A33 steady-state).
- **`DeliveryRetryManager` consumers** — `AgentServer` constructs and `start()`s the manager. The wrap of `tick()` is a no-op for the timer caller (it still returns the same shape, just with an optional `skipped` field that's `undefined`/falsy under normal operation).
- **`MessageStore.queryInbox`** — the verify probe calls this. It's a stable public method used by many other consumers; the additional read load is one inbox scan per dispatch attempt, well below the per-cycle scan rate.
- **F-4 `MachineLock`** — the runbook acquires the same in-flight tuple lock the dispatcher acquires for any runbook. No new lock surface.
- **`AgentServer` boot wiring** — NOT modified in this PR. Production wiring of `setMessagingDeliveryDeps(...)` is deferred to the same future PR that wires `DegradationReporter.setRemediator(...)`. Both must be wired together so the runbook actually receives events.

The wrap of `tick()`'s body into `doCycle()` is the only behavior change to existing code. Verified by running the existing `delivery-retry-manager.test.ts` (21 cases, all pass unchanged).

---

## 6. Rollback cost

**If this change is reverted, what breaks?**

Low — additive. The legacy `tick()` and `start()` are unchanged in behavior; reverting deletes the new runbook module + the two new public methods + the shared latch wrap on `tick()`. No data-model migration. No persistent state ships with this PR. The shared latch is a `boolean` field; deleting it removes the additional idempotence guarantee but does not corrupt any state. Existing F-1..F-7 + W-1 modules are unaffected.

A revert leaves messaging recovery on the pre-existing 15s timer cadence — the Remediator-orchestrated faster-recovery + audit-tracked path is the gain that's lost on revert, not a load-bearing capability.

---

## 7. Spec compliance

- §A1 W-3 manifest — runbook id `messaging-delivery-failed`, surface `delivery-retry`. Matches the spec table row.
- §A6 — `provenance: ['subsystem-explicit', 'probe-id']`; explicitly NO `free-text`. Registry validator (F-8) accepts this at registry-load.
- §A9 — verify queries the durable on-disk inbox (not the in-memory retryState map), counts ALL queued+undelivered, requires zero. "Drain ALL stuck messages (not just one)" matches the spec language verbatim.
- §A21 — verify taxonomy: ok → verified-healthy; stuck (count > 0) → verify-failed; probe error → verify-inconclusive.
- §A34 R3 — `runRecoveryCycle()` is a NEW public method, distinct from timer-driven `tick()`. Idempotent against the running timer via the shared `cycleInFlight` latch. Spec docstring captures this.
- §A36 — essential=false validated against blastRadius=process. F-8 validator accepts.
- §A57 — Tier-2 W-3 row. Foundation dependency on W-1 (in main as PR #202) and F-8 (in main as PR #201 + #217). W-2 is parallel work; this PR does not block on it.
- §A15 (note from prompt) — lag rule is documented in the runbook expectedRuntimeMs (60s). The recovery cycle is short-lived; lag-detection escalation is the Remediator's concern, not this runbook's. Build proceeds per W-2's pattern.

---

## 8. Test coverage

27 new tests across two files. Pass: 27/27.

`tests/unit/DeliveryRetryManager-runRecoveryCycle.test.ts` (11):
- runRecoveryCycle is a distinct public method from tick.
- runRecoveryCycle return shape matches tick on empty inbox.
- runRecoveryCycle processes queued messages identically to tick (TTL-expired envelope dead-lettered).
- Idempotence: runRecoveryCycle short-circuits while tick is in-flight.
- Idempotence: tick short-circuits while runRecoveryCycle is in-flight (symmetric).
- Latch resets after cycle completes; subsequent calls run normally.
- invokeFromRemediator wraps runRecoveryCycle and returns ExecutionResult success.
- invokeFromRemediator returns failure when runRecoveryCycle throws (synthetic store error).
- invokeFromRemediator reports skipped:true when cycle is in-flight.
- stop() clears the in-flight latch (recycle-safe).
- Existing tick() return shape unchanged when cycle runs normally.

`tests/unit/runbooks/messaging-delivery-failed.test.ts` (16):
- Matches all three structured errorCodes.
- §A6: free-text excluded from prefilter.
- match() rejects non-messaging subsystems.
- Remediator.registerRunbook accepts the runbook (essential=false, process radius).
- §A36 honored: essential=false, blastRadius=process.
- Manifest fields verified (id, priority=80, surface=delivery-retry, expectedRuntimeMs=60_000, reversibility=reversible).
- preconditions fail when deps not wired.
- preconditions succeed when manager is wired.
- surfaceCallable invokes manager.invokeFromRemediator with ctx (mocked).
- verify() returns verified-healthy on drained inbox.
- verify() returns verify-failed on stuck messages (with stuck count + sample IDs).
- verify() returns verify-inconclusive on store probe error.
- verify() against real store: queued message → verify-failed (durable assertion).
- verify() against real store: empty inbox → verified-healthy.
- End-to-end dispatch on TELEGRAM_429: invoked → verified-healthy → audited.
- End-to-end dispatch with stuck messages: verify-failed audited (synthetic deliverToSession failure).

Existing `tests/unit/delivery-retry-manager.test.ts` (21) and `tests/unit/runbooks/node-abi-mismatch.test.ts` (12) re-verified — unchanged behavior. Existing `tests/unit/Remediator.test.ts` (12) re-verified — unchanged behavior.

---

## 9. Open follow-ups

- **Production wiring** of `setMessagingDeliveryDeps(...)` and `DegradationReporter.setRemediator(...)` is deferred to a coordinated Tier-2 PR. This PR ships the unit-testable surface; production registration is a single-PR follow-up.
- **F-3 emit-site migration** in `src/messaging/` — the structured errorCodes DELIVERY_FAILURE / TELEGRAM_429 / TELEGRAM_500 need to flow through `reportStructured(...)`. Until then, the runbook is dormant in production (intended A33 incremental migration).
- **W-2** (`supervisor-preflight`) and **W-4** (`db-corruption`) — parallel wrapper work; this PR does not depend on either.
