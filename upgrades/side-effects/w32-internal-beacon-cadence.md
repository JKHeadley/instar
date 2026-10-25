# Side-Effects Review — Window 32 internal beacon cadence

**Version / slug:** `w32-internal-beacon-cadence`
**Date:** `2026-09-07`
**Author:** `Echo`
**Second-pass reviewer:** `Mencius — CONCUR after revision`

## Summary of the change

This change corrects the split between PromiseBeacon's optional human-facing output and its internal follow-through. In `src/monitoring/PromiseBeacon.ts`, quiet hours and the daily LLM spend cap continue to suppress opted-in user output, but no longer suppress output-disabled heartbeat bookkeeping or the pre-existing session-loss/revival ladder. Unit, integration, and booted-server E2E regressions prove both suppressors can be active while the owner advances or revives internally, the standby remains inert, and no send, summary LLM call, or Attention action occurs. The recurring write is explicitly registered as the `promise-beacon-internal-cadence` rate-floored eternal-sentinel controller, bringing it under the shared N/2N and restart convergence ratchet. The repository lifecycle E2E also gives its manual and cron-triggered jobs distinct slugs so their intentionally concurrent paths do not trip the real per-slug double-run guard. After rebasing onto `JKHeadley/main` at `80cc52663` / version `1.3.1226`, the full gate exposed a second W32 defect: artifact verification asked `AutonomousRunStore.isOpen()` to use the host wall clock while the rest of the liveness authority used its injected authoritative clock. Historical/deterministic lifecycle runs therefore appeared expired only at the receipt boundary. `WindowRunLivenessAuthority` now captures one validated authority timestamp and supplies it to artifact authorization and receipt stamping; `AgentServer` requires that instant to be strictly before the finite run ceiling. Exact-ceiling, verification-crossing, and invalid-clock negatives pin the boundary.

## Decision-point inventory

- `PromiseBeacon.fire()` quiet-hours gate — **modify** — applies only when human output is enabled; output-disabled commitments continue into internal cadence bookkeeping.
- `PromiseBeacon.fire()` daily-spend gate — **modify** — applies only when human output is enabled; output-disabled bookkeeping spends no LLM budget and remains live.
- `PromiseBeacon.fire()` session-loss ladder — **newly reachable under the two suppressor conditions, not otherwise modified** — owner-gated revival and internal terminal transitions retain the existing output-off contract; every downstream human sink remains closed.
- `SELF_ACTION_CONTROLLERS` — **extend** — models the durable internal heartbeat as a constant-cost, 60-second-rate-floored eternal sentinel with restart-surviving cadence state.
- `tests/e2e/lifecycle.test.ts` job identity — **modify test fixture only** — separates manual-trigger and cron-trigger subjects while preserving the production double-run refusal.
- `AgentServer` W32 artifact-verification boundary — **modify** — evaluates autonomous-run expiry with the same injected authority clock used by liveness sampling instead of silently switching to host wall time.

---

## 1. Over-block

No new legitimate input is rejected. When `userOutputEnabled === true`, quiet-hours and daily-spend suppression retain their existing behavior. When output is disabled, the change removes an accidental block on internal bookkeeping; it does not enable any delivery path.

---

## 2. Under-block

This fix does not make every commitment a runtime-liveness source. Commitments with human output explicitly enabled remain subject to quiet hours and the spend cap, including the existing suppression record. Runtime authorities must continue to use the deliberately output-disabled commitment profile used by Window 32. Output-disabled owner commitments can now reach the already-declared session-loss ladder during quiet hours or exhausted spend; this can request a revival or produce an internal terminal transition, while its send and Attention sinks remain suppressed. Non-owners return before both heartbeat mutation and revival. Other causes of stale heartbeats—expired commitments, stopped timers, or failed durable writes—remain governed by their existing checks and are not masked here.

---

## 3. Level-of-abstraction fit

The split belongs in `PromiseBeacon.fire()`, where the existing `userOutputEnabled` authority already separates user-visible delivery from internal follow-through. Moving the exception into WindowRunLivenessAuthority would fabricate freshness downstream; moving it into the tracker would make persistence guess delivery policy. The W32 clock correction belongs at `AgentServer`'s artifact-verification adapter, because that adapter combines the injected lifecycle clock with `AutonomousRunStore`'s explicit `now` parameter; changing the store's default would affect unrelated callers. The E2E-only job identity correction belongs in the fixture because the production per-slug concurrency guard is correct and must not be weakened.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — this change is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [x] Deterministic policy authority over an enumerable configuration boundary; no brittle semantic detector is introduced.

The touched decisions are explicit policy mechanics: whether human output is enabled, whether the current time is within configured quiet hours, and whether a configured spend ceiling has been reached. The change does not infer message meaning or agent intent. It narrows those delivery suppressors to the surface they govern and leaves liveness evaluation with the existing server-owned authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic is added at a competing-signals decision point. `userOutputEnabled` is an explicit boolean contract, quiet hours are an explicit configured interval, and the spend cap is an explicit numeric ceiling. The liveness authority still evaluates ownership, admission, heartbeat, work evidence, and lifecycle state; this patch does not replace that judgment with a shortcut.

---

## 5. Interactions

- **Shadowing:** Quiet-hours and spend checks still precede all human delivery work when output is enabled. When output is disabled, control reaches the pre-existing session-loss ladder first, then the bookkeeping-only branch for a healthy session. Any Rung-2 send or Rung-3 Attention attempt is suppressed at the canonical output boundary.
- **Double-fire:** No new timer, send, retry, or attention path is added. A normal healthy `fire()` performs one bookkeeping mutation. A session-loss `fire()` may instead perform the pre-existing bounded escalation mutation/spawn path; the regression suite pins owner-only actuation.
- **Races:** The PromiseBeacon change does not alter timer ownership or commitment CAS behavior. The E2E fixture removes a test-only race by giving cron and manual triggers different production identities.
- **Feedback loops:** The fresher heartbeat becomes input to WindowRunLivenessAuthority, which is the intended consumer. It does not cause PromiseBeacon to reschedule faster or produce user output. The `promise-beacon-internal-cadence` convergence model carries the same durable cadence anchor as production and is exercised at N, 2N, and restart horizons.
- **Clock coherence:** Receipt authorization and receipt stamping share one validated W32 timestamp. The adapter requires `observedAt < endAt`, matching freeze's `now >= endAt` rule; a request cannot gain an equality-window receipt, and a verifier that finishes after the ceiling cannot trigger a second clock sample. Invalid injected clocks fail closed before artifact verification. Production still defaults the authority clock to current wall time.

---

## 6. External surfaces

Other agents receive the corrected behavior after package update: output-disabled PromiseBeacon commitments continue recording internal heartbeats—and can run the existing owner-only revival ladder—overnight and after the user-output LLM budget is exhausted. There is no Telegram, Slack, Attention, URL, route, or response-format change. Persistent commitment records may now advance `lastHeartbeatAt`, `escalationAttempts`, or the existing internal terminal fields in cases where an output-only suppressor previously short-circuited the tick; no schema or migration is required. W32 receipt authorization now uses the already-configured authority clock; under the normal production default this is behaviorally identical, while deterministic or injected-clock deployments stop falsely rejecting an otherwise open bound run. At the exact ceiling it now refuses the receipt consistently with lifecycle freeze, and an invalid injected clock cannot fall back to another clock domain. The three-tier regressions pin zero sends, zero summary LLM generations, zero Attention actions, owner-only mutation, bounded cadence, and coherent receipt-time evaluation. No operator-facing action is added or changed.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** PromiseBeacon timers and heartbeat observations describe the session executor on the machine running that commitment. Existing session ownership and speaker-election checks remain the one-voice authority for any opted-in user notice. This change emits no user-facing notice, creates no URL, and introduces no new durable store. The existing commitment replication/ownership mechanisms remain responsible for topic transfer; this patch only ensures the owning machine's output-disabled timer records its local heartbeat instead of being suppressed by a human-output policy.

---

## 8. Rollback cost

Rollback is a code/test revert followed by a patch release; there is no schema migration. Before rollback, an output-disabled owner may already have advanced `lastHeartbeatAt`, requested a revival, incremented the existing escalation fields, or reached an existing internal terminal state. Those records remain valid historical state and must not be erased. An already-spawned revival is allowed to settle through the existing idempotent escalation lifecycle rather than being killed or rewritten. After rollback, later output-disabled overnight ticks would again be suppressed by quiet hours or exhausted spend and could appear stale to downstream liveness checks; injected-clock W32 runs could also be falsely rejected at work-advance if their authority time differs from the host wall clock. Human-facing PromiseBeacon sends and Attention actions remain absent throughout unless the deployment separately opts user output in.

---

## Conclusion

The review found that the PromiseBeacon runtime fix is at the correct authority boundary and does not broaden messaging or LLM spending. It deliberately restores the previously declared internal session-loss behavior under two output-only suppressors, so owner-only revival, cadence rate bounds, and closed human sinks are now explicit test obligations. The production concurrency guard remains intact; only the E2E subjects are separated. The first post-rebase full gate executed 51,228 tests and found five failures across three files: four W32 assertions traced to the receipt clock-source split, plus the expected stale generated-manifest check after source modification. The first clock correction cleared those failures, but independent review found exact-ceiling, crossing, and invalid-clock holes. The authority now captures one validated timestamp, and the production adapter requires it to be strictly before the run ceiling. The complete changed proof set and the fresh repository-wide `npm run test:all` gate are green. This remains Tier 2 because it changes when an autonomous session-recovery path is reachable, adds a W32 authority-clock correction, carries complete three-tier proof, and extends the self-action convergence ratchet. The approved `docs/specs/PROMISE-BEACON-ESCALATION-SPEC.md` is the governing PromiseBeacon spec; the existing W32 lifecycle contract governs the clock correction. The independent second pass concurs with the final expanded diff.

---

## Second-pass review (required)

**Reviewer:** Mencius
**Independent read of the artifact:** **CONCUR after revision.** The initial review found that the artifact omitted newly reachable session-loss actuation, the convergence citation did not model the durable internal write, and the proof lacked production-lifecycle owner/non-owner coverage. A second review then caught that eternal-sentinel restart callbacks were only type-checked and that rollback understated already-persisted revival state. Those issues were resolved. After the full gate exposed the host-clock split, the reviewer found three further boundary holes: inclusive `isOpen()` behavior at exact equality, separate authorization/stamping clock samples, and invalid-clock fallback. The final implementation captures one validated timestamp in the authority, uses it for verification and stamping, enforces finite strict-before-ceiling time in the production adapter without changing `AutonomousRunStore` globally, and adds equality/crossing/invalid-clock negatives. The reviewer confirms the 230-test changed/affected gate is proportionate, the rollback wording is honest, and no blocker remains.

---

## Evidence pointers

- Codex command receipt: session `01a07395-0f77-7cc0-a81a-cee974cec88a`, `npm run test:all`, exit `0`, completed `2026-09-06T08:24:16.812Z` after 3,737 seconds.
- Exact E2E tail: 351 files passed, 3,153 tests passed, 7 skipped, 3 todo, zero failed.
- Focused unit regression: `tests/unit/promise-beacon-user-output-off.test.ts`.
- Tracker integration regression: `tests/integration/PromiseBeacon-lifecycle.test.ts`.
- Production lifecycle regressions: `tests/e2e/promise-escalation-lifecycle.test.ts` and `tests/e2e/lifecycle.test.ts`.
- Autonomous convergence ratchet: `tests/unit/self-action-convergence.test.ts`, controller `promise-beacon-internal-cadence`.
- Post-rebase gate receipt: 3,274 files / 51,228 tests considered; 51,191 passed, 29 skipped, 3 todo, and 5 failed before correction. Failures were `builtin-manifest.test.ts` (generated artifact stale), `window-lifecycle-expiry-freeze-production.test.ts` (one work-advance rejection), and `window-run-liveness-production-wiring.test.ts` (three downstream assertions from the same receipt rejection).
- First corrected focused gate: seven files / 205 tests passed after `npm run build`, including both W32 production lifecycle files, the generated-manifest freshness check, all changed PromiseBeacon tiers, and the convergence ratchet.
- Final changed/affected gate: eight files / 230 tests passed after rebuilding, covering single-sample receipt stamping, verification crossing, invalid authority time, exact-ceiling refusal, liveness recovery, expiry freeze, all PromiseBeacon tiers, the convergence ratchet, and generated-manifest freshness.
- Final repository gate: `npm run test:all`, exit `0`, completed 2026-09-07. Its E2E tier passed 351 files and 3,154 tests, with 7 skipped and 3 todo; the exact W32 production lifecycle passed in both executions (approximately 320 and 318 seconds).

---

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: {enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the dedicated promise-beacon-internal-cadence eternal-sentinel model uses the production 60-second minimum and durable last-heartbeat anchor; the shared ratchet drives sustained pressure at N and 2N horizons and reconstructs the controller across restarts, failing if internal refreshes accelerate or lose their restart-surviving rate floor}`.
