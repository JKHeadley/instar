# Side-Effects Review — A send held for a lapsed lease renewal is retried within seconds, named, logged and counted

**Version / slug:** `lease-freshness-lapse-retry`
**Date:** `2026-11-21`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `not required at Tier 1; the spec's three convergence rounds (six internal lenses, codex and the Anthropic clean-door reader) reviewed every decision point against the live code paths — see docs/specs/reports/lease-freshness-lapse-retry-convergence.md`

## Summary of the change

Tier 1 (a narrow, revertible fix to the Telegram origin send path, no switch). Size: about 250 lines across 13 source files (`OriginEgressCapacity.ts`, `OriginBotEgress.ts`, `OriginRetry.ts`, `TelegramOriginService.ts`, `TelegramOriginRuntime.ts`, `TelegramOriginBoot.ts`, `OriginStoreBackend.ts`, `OriginAwareness.ts`, `TelegramAdapter.ts`, `LeaseCoordinator.ts`, `MultiMachineCoordinator.ts`, `NeverSilentStore.ts`, `neverSilentRoutes.ts`, `CapabilityIndex.ts`, `commands/server.ts`) plus six test files. Effort: 3 spec review rounds (the Tier-1 cap; each found a real defect in the retry or reporting mechanics, and the design shrank in the last round), 1 commit attempt. ⚠ Three rounds on a Tier-1 change is above the usual proportion; the reason is recorded in the convergence report.

What it does: when the machine holding the multi-machine lead refuses one of its own Telegram sends at the network boundary because `holdsLease()` is false at that instant, the refusal is (1) named from what the lease coordinator itself observed (`lease-freshness-lapsed` when its renewal fence answered, `lease-not-held-at-send` otherwise or when unmeasured) instead of the rate-cap name `credential-capacity-unavailable`, logged once with the verdict and the renewal gap, and the two post-grant causes are explained but keep the old name; (2) retried within seconds once the lease is held again — the durable row is due in 2 s instead of 30 s, a bounded in-runtime timer (2 s, 5 s, 10 s, 30 s; four wakes per lease lifetime) runs the existing recovery pass only when the lease is held, the pass skips such rows while the lease is away, a replay refused again has its review-schedule row moved to 2 s, and the first-detection delivery notice no longer fires for these reasons; (3) counted as a `sendHolds` row in the never-silent store, closed with the delivery time from a receipt-bound `onDelivered` callback. The lease reasons join the sticky lease-held set so the existing 30-minute hand-back covers them.

## Decision-point inventory

- `OriginEgressCapacity.reserveExplained` / `#liveCause` — modify — the same refusal as before (closed, not ready, lease, account, reader threw, window) with the cause captured in the refusing evaluation; where a freshness reader exists it is the lease read (permission and reason from one snapshot).
- `OriginBotEgress.wire.prepare` — modify — the thrown `OriginCapacityUnavailable` keeps its cause through the request-bound proof; grant expiry and a refused consume are named (`grant-expired`, `consume-refused`) under the old durable name.
- `TelegramOriginService` local-refusal branch — modify — durable reason from `originLocalRefusalReason`, 2 s next attempt for lease reasons, one log line; `#hold` adds lease reasons to `#leaseHeldIds`; `onDelivered` fired after the recorded receipt; the expired-permit site logs.
- `OriginStoreBackend.recordOutcome` — modify — accepts the three local-refusal reasons; on a lease reason moves an earlier-dated review-schedule row to the same next attempt.
- `TelegramOriginRuntime.onHold` — modify — lease reasons excluded from the live `onSessionDeliveryHeld` notice; they record a send hold and arm the retry episode.
- `TelegramOriginRuntime.recoverHeld` — modify — skips a lease-reason candidate while `holdsLease()` is false, after the §2(b) age check, before any store write or reservation.
- `TelegramOriginRuntime` retry timer — add — reads `holdsLease()`, runs `recoverHeld()` (after any running pass) only when held, four steps, four wakes per lifetime, terminal last step, never sends.
- `LeaseCoordinator.holdVerdict` / `renewalFreshness`, `MultiMachineCoordinator.leaseFreshness` — add — read-only readers of the existing fence; no fence change.
- `NeverSilentStore.sendHolds` and `GET /never-silent/incidents` — add — observability rows and counts; never read by the judge, notices or actions.
- `TelegramAdapter.OWNER_DM_RETRIED_HOLDS` — modify — lists the two new reasons (lists-in-sync test extended).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None new. The capacity refuses exactly what it refused before: `reserveExplained` evaluates the same six conditions in the same order, and `reserve()` is `reserveExplained().grant`. Where a freshness reader exists, permission is `verdict === 'holding'`, which is `holdsLease()`'s own answer (same checks, same order, `holdVerdict()` is a reader beside it), so no send that `ownsLease()` would have allowed is refused. The recovery-pass skip refuses nothing: it declines to spend a reservation on a row the capacity would refuse at the boundary anyway, and the row is retried as soon as the lease is held. The one removed notice (first-detection "a reply needs delivery attention" for the two lease reasons) is a notice that was itself refused by the same lapse and landed stale; a hold that persists still reaches the operator through the existing five-minute scan (record-only item) and the 30-minute hand-back.

---

## 2. Under-block

**What failure modes does this still miss?**

- A lease refusal on the Lifeline-owner deployment (the server as IPC client) is still unexplained and keeps the old name; the Lifeline's own capacity reads a configuration flag, so the lapse does not arise there (spec Frontloaded Decision 6).
- After a process restart the in-memory hold map and the timer are gone: the row is retried by the sentinel pass on today's cadence, and a lapse hold younger than 30 minutes at restart is outside the hand-back bound until a row is found stale (spec Left behind).
- A crash between the recorded receipt and the `onDelivered` callback leaves a send hold to close as `hold-unobserved-past-deadline`; the two stores are not reconciled by a recurring check (accepted in the convergence report).
- The expired-permit hold site (`prepared.valid()` false) now logs but still writes no outcome row and is not counted.
- "Within seconds" is a lower bound, not a guarantee: a self-suspended coordinator re-acquires on its 5 s pull tick (so the 5 s step is the realistic first delivery), the pass serves ten rows at a time, and a refusal arriving with the wake budget spent waits for the 30 s sentinel pass.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The cause is captured where the decision is made (the capacity's one evaluation), named where the durable outcome is written (the service's local-refusal branch), and the lease verdict comes from the lease coordinator, the only component that knows which of its checks answered. The retry is a thin trigger of the existing recovery pass (single-flight, all gates), not a second send loop; the alternative of changing the sentinel cadence or the review ladder for everyone was rejected as wider than the defect. The count rides on the existing never-silent store and route rather than a new metrics surface, because the question it answers ("why did a conversation go quiet, and for how long?") is the one that route already answers; it is a list beside the incidents, not an incident, so the watcher's judge and actions are untouched. Prevention (a shorter renewal cadence) belongs to the lease coordinator and is filed as fb-5422a875-8e4 rather than folded in here.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no new block/allow surface.
- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The only blocking authority in the path, the capacity's refusal while the lease is not held, already exists and is the deterministic safety guard on an irreversible action (a Telegram send from a non-holder cannot be recalled) that the principle explicitly allows. This change adds no block: it names the existing refusal, logs it, counts it, and asks "is the lease held again?" before re-running the same gates sooner. The timer never sends; the skip never refuses; the removed notice is replaced by existing channels; the never-silent rows are data no gate reads.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

The one static heuristic added is the retry schedule (2 s, 5 s, 10 s, 30 s) with its four-wakes-per-lifetime budget. It is declared a judgment-candidate within a complete floor in the spec's `## Decision points touched`: the timer never sends, is bounded, never resets on repeat refusals, and the 30 s sentinel pass remains underneath, so no arbiter is needed; the steps are tied to the renewal cadence and the coordinator's 5 s re-acquire tick. Every other decision row is an invariant with a stated basis (irreversible consequence, enumerable domain, or an external constraint of the existing store and fence). No new static heuristic sits at a competing-signals point: the first-detection notice question (operator rules "Needs-you only for things the user acts on" and "an over-eager hold notice IS the incident" versus "the operator hears when self-heal is exhausted") was resolved by routing exhaustion through the existing scan and hand-back rather than a new rule.

---

## 5. Interactions

- **Shadowing:** the lease reasons are checked in `onHold` before the existing exclusion list; `credential-capacity-unavailable` and every other reason keep today's notice path (tested). In `recoverHeld` the new skip runs after the §2(b) age check and before `markLateDirect`/`reserveRecoveryAttempt`, mirroring the `lease-not-held` branch; a stale lease-held reply is still handed back while the lease is away.
- **Double-fire:** the timer and the sentinel both call `recoverHeld()`, which is single-flight (`recovering`); the timer waits for a running pass (`#passDone`) and then runs one so a wake is not lost. The budget (four wakes per lifetime) bounds the extra passes to four per 60 s on top of the sentinel's two.
- **Races:** a lease flip between the pass's `holdsLease()` read and the boundary is refused again by the capacity and recorded as another local refusal (not charged); the review-schedule row is moved to 2 s in the same transaction so the ladder does not hold it. `reserveExplained` captures the cause in the evaluation that refused, so a flip between two reads cannot mislabel the reason.
- **Feedback loops:** the removed first-detection notice was a send through the refused capacity (held by the same lapse); removing it removes a loop, not adds one. The never-silent `snapshot()` may flush when it closes an expired hold; it flushes only then.
- **Cleanup:** `close()` clears the timer; `pruneExpiredHolds` deleting a hold also ends the timer's "holds remain" condition at the next step.

---

## 6. External surfaces

- Other agents on the same machine: none (per-agent origin store and never-silent file).
- Install base: every agent whose server owns the Telegram poll gets the new reason names in outcome rows, the log lines, the 2 s retry and the removed first-detection notice for lease refusals. `credential-capacity-unavailable` stays accepted everywhere it was matched (`OWNER_DM_RETRIED_HOLDS`, the store's local-refusal write, the notice lane).
- External systems: Telegram receives the same sends, sooner; nothing new is sent.
- Persistent state: outcome rows with two new reason strings; `never-silent.json` gains an additive `sendHolds` list (older readers carry it along). `GET /never-silent/incidents` gains `sendHolds` and `counts.openSendHolds`; `counts.openIncidents` is unchanged.
- Timing: the timer depends on the coordinator's re-acquire cadence (5 s pull tick) and the sentinel's 30 s pass; both are stated bounds, not assumptions of success.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action is added or changed; the route is read-only. "No operator-facing actions" applies.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard renderer, approval page or form is touched; the only reader-visible additions are a read-only route field and server log lines.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** — `machine-local-justification: physical-credential-locality`. The send capacity is one in-memory authority per credential-owner process, keyed by `ownerBootId`, bound to the Telegram bot token and the lease that says which process may use it; its refusals, the retry timer and the log lines describe that machine's own attempts against its own copy of the fence. The held reply is already durable in that machine's origin store and follows the existing recovery, hand-back and forward paths unchanged. Send holds are written to the never-silent store of the machine that held the send (the machine that holds or just lost the lead and runs the conversation); a lease-refused row never forwards to another machine for this reason; the route's answer is for this machine, as every row of that route already is. No user-facing notice or item is emitted (one notice is removed from first detection), so no one-voice gating is added; no URL is generated; no durable state strands on topic transfer (the rows describe a send, not a conversation's custody). The Lifeline process (no lease coordinator) is unchanged.

**Status surfaces:** `GET /never-silent/incidents` gains `sendHolds` and `counts.openSendHolds` (this machine; a dark holder is unreadable, never shown healthy). `/health`, `/status`, `/capabilities` and `/channels` keep their answers; the capability description of the never-silent route names the new list.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit and ship as the next patch. Pure code change.
- **Data migration:** none. Outcome rows with the new reasons remain readable (every reader matches by string; retry reads `next_attempt_at`, not the reason). The `sendHolds` list in `never-silent.json` is ignored by the old reader and carried along by its writer; it is inert.
- **Agent state repair:** none.
- **User visibility:** a revert restores the old name, the 30 s first retry, the silent lapse and the first-detection notice; no regression beyond today's behavior.

---

## Conclusion

The review confirmed the change adds no blocking authority: it names, logs, counts and shortens the recovery of an existing fail-closed refusal without touching the fence. The convergence rounds changed the design materially before code was written — the cause is captured atomically, the durable name comes from the coordinator's own verdict, the timer waits for a running pass and is budgeted, a replay refusal moves its schedule row, the first-detection notice is removed in favor of the existing scan and hand-back, and the count lives in its own list so a revert is pure. Remaining gaps (Lifeline-owner deployment, restart losing the young-hold bound, unobserved close on a crash between receipt and callback, the expired-permit site uncounted) are stated and accepted. Clear to ship after the targeted tests pass.

---

## Second-pass review (if required)

**Reviewer:** not required (Tier 1). The spec's convergence (security/adversarial, scalability/integration, decision-completeness, lessons-aware, codex, Anthropic clean-door; three rounds) stands as the independent read of these decision points.

---

## Evidence pointers

- `tests/unit/telegram-origin/lease-freshness-lapse.test.ts` — the boundary refusal, naming, log line, count, skip while away, delivery when held, timer delivery, terminal episode and budget, replay schedule rewind.
- `tests/unit/telegram-origin/egress-capacity.test.ts` — `reserveExplained` causes and precedence, one-snapshot reader, `originLocalRefusalReason`.
- `tests/unit/telegram-origin/known-failure-retry.test.ts` — `nextOriginLeaseLapse` and the schedule shape.
- `tests/unit/telegram-owner-dm-outcome.test.ts` — the lists in sync; lease reasons waited for.
- `tests/unit/neverSilent-send-hold.test.ts` — the send-hold list lifecycle, older file shape, retention cap.
- `tests/unit/LeaseCoordinator.test.ts` — `holdVerdict()` and `renewalFreshness()` on both timelines.
- Spec and convergence report: `docs/specs/lease-freshness-lapse-retry.md`, `docs/specs/reports/lease-freshness-lapse-retry-convergence.md`.

---

## Class-Closure Declaration (display-only mirror)

This change fixes a defect in runtime code (a mislabeled, silent, slowly retried refusal), not in an agent-authored artifact (prompt, hook, config, skill or standards text). It adds a self-triggered controller (the retry timer: a bounded loop that re-drives the existing recovery pass), so the `unbounded-self-action` class applies:

- **`defectClass`**: `unbounded-self-action`
- **`closure`**: `guard`
- **`guardEvidence`**: `{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts and tests/unit/telegram-origin/lease-freshness-lapse.test.ts ("ends the episode after its last step with no item when the lease never returns, inside the wake budget"), howCaught: the control-loop edge is the lease being held again (one boolean read per wake), the steady-state bound is four wakes per lease lifetime whatever they observe and a terminal fourth step, and the settling brake is the single-flight recovery pass plus the sentinel's regular cadence underneath, so a flapping or absent lease settles to at most four extra passes per 60 s; the test asserts the terminal step and the spent budget directly }`
- **`gap`**: not applicable.
