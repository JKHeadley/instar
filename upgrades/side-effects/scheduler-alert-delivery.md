# Side-Effects Review — Scheduler alert delivery across Telegram startup modes

**Version / slug:** `scheduler-alert-delivery`
**Date:** `2026-08-03`
**Author:** `Instar-codey`
**Second-pass reviewer:** `scheduler_alert_side_effect_review`

## Summary of the change

This change resolves every production Telegram topology in `src/commands/telegramSendSideComposition.ts`, moves polling-independent handoffs in `src/commands/server.ts` behind one shared composition seam, makes missing delivery sinks loud through `src/messaging/DeliverySinkFailure.ts`, and changes `src/scheduler/JobScheduler.ts` from an exact-threshold one-shot into a persistent bounded escalation episode with scheduler-owned wakeup timers. `src/messaging/NotificationBatcher.ts` adopts the same missing-sink primitive. Startup explicitly finalizes alert composition even when its result is “no sink,” preserving loud retry state through reconstruction and pause/resume. The tests compose all four startup arrangements with real scheduler, batcher, and Telegram adapter objects; pin threshold, timer-owned cadence, configured- and missing-sink restart/resume rehydration, stop/recovery cancellation, overlap, and single-sink behavior; and register the new self-triggered notification controller with the repository convergence ratchet.

## Decision-point inventory

- `resolveTelegramStartupTopology` — add — enumerates explicit send-only, standby, Lifeline-polling, server-polling, and unconfigured arrangements; separately declares whether this machine owns the stateful Threadline bridge.
- `startServer / Telegram ownership branches` — modify — the resolved mode selects send-only versus server-polling construction, but no longer controls outbound dependency handoffs.
- `wireTelegramSendSide` — add — deterministically hands the selected real adapter to the scheduler and notification batcher after either ownership branch.
- `startServer / post-branch Telegram consumers` — modify — Threadline bridge construction and scheduler role-guard notification wiring now occur after both startup branches.
- `startServer / TopicMemory readiness` — modify — scheduler receives TopicMemory only after `open()` has completed.
- `JobScheduler.alertOnConsecutiveFailures` — modify — alert eligibility is at-or-past threshold, while durable next-eligible state and scheduler-owned timers own retry and reminder timing.
- `JobScheduler.activateFailureAlertDelivery` — add — separates “composition complete” from “a sink exists,” then rehydrates persisted alert timers after the scheduler is running even when the composed result is intentionally no sink.
- `TelegramBridge / live ownership` — modify — every send-capable process may prepare the bridge, but every inbound/outbound mirror checks a live awake-and-lease-holder predicate before topic creation, send, or binding persistence.
- `JobScheduler alert sink selection` — modify — a job topic uses Telegram topic delivery; otherwise the generic messenger is used; both are never invoked for one alert.
- `NotificationBatcher.sendDirect` — modify — an absent or throwing sink records explicit degradation rather than silently returning.
- `job-failure-alert-delivery self-action model` — add — permanent transport failure is classified as an Eternal Sentinel with persistent rate-floor state across reconstruction.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The timing gates suppress only repeated sends within a declared alert episode; they do not block job execution, message receipt, user commands, or recovery. A new failure episode after a recorded successful job run is immediately eligible again.

---

## 2. Under-block

The remote send and local persistence are not one atomic transaction. If Telegram accepts an alert and the process terminates before the success state is written, reconstruction can send one duplicate. The in-process in-flight set cannot cover a process crash, and Telegram does not expose a caller-supplied idempotency key for this message path.

A successful API response proves transport acceptance, not that the user read or acknowledged the alert. `deliveredCount` is intentionally transport-delivery state, so unresolved reminders continue even without human acknowledgment.

Alert cadence state is held in the scheduler owner's local runtime state. A machine-ownership handoff may produce one immediate alert from the new owner because its delivery attempt context is distinct. Existing job claim and lease gates prevent simultaneous owners, so this cannot become two alert timer loops; each owner still enters the same widening cadence.

Permanent delivery failure never reaches a terminal silent state. It retries indefinitely at the one-hour cap after the first 5-minute and 15-minute delays. This is deliberate Eternal Sentinel behavior, with constant per-attempt cost and a tested minimum rate floor.

---

## 3. Level-of-abstraction fit

The startup fix sits at the composition boundary, where the system knows which adapter instance was constructed and which consumers need it. That is the correct layer for a branch-shaped dependency-handoff defect; repairing only `JobScheduler` would leave the notification batcher, Threadline bridge, and role guard exposed to the same branch omission.

The shared sink helper is a low-level reporting primitive. It detects only the enumerable fact that a sink is absent or threw, emits degradation, and leaves retry authority to the owning component. The scheduler state machine is the correct higher layer for retry timing because it knows failure episodes and recovery.

The cadence rules are deterministic temporal invariants, not conversational judgment. They use the existing StateManager for durable local state, scheduler lifecycle timers for wakeups, and the repository self-action registry rather than introducing a parallel persistence or convergence mechanism.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design. Brittle detectors must not own block authority.

The code emits or suppresses duplicate outbound alert attempts according to a fully enumerated temporal state machine. It does not accept or reject user intent and does not block job execution. Missing-sink detection feeds the existing degradation surface; it does not gain authority over another subsystem.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The inputs are exact: failure count, configured threshold, prior delivery result, recovery, and elapsed time. The choice is an enumerable delivery/idempotency invariant with frozen intervals, not a conflict among semantic signals requiring an arbiter.

---

## 5. Interactions

- **Shadowing:** The topology resolver runs before construction and the shared send-side seam runs only after its chosen Telegram adapter branch has succeeded. It does not start polling, so it cannot shadow the Lifeline/server polling ownership check. TopicMemory handoff now follows `TopicMemory.open()` and replaces the former startup-time readiness check that could only observe an unready object.
- **Double-fire:** Both `messenger` and `telegram` point to the same real adapter after composition. Scheduler selection is exclusive: topic-aware delivery wins only when the job has a topic, otherwise generic delivery runs. Tests assert that the losing sink receives zero calls.
- **Races:** Multiple failure callbacks can reach the alert method before a remote send resolves. The per-job in-flight set coalesces them inside one process, and each state update replaces the prior per-job timer. Persistent `nextEligibleAt` state prevents subsequent runs or reconstruction from bypassing cadence. State is written before send attempt and again after the outcome; stop and recovery clear timers, resume re-arms any timer that expired while paused, and an attempt id prevents a late send result from resurrecting a recovered episode. An explicit composition-complete flag allows both configured-sink and missing-sink episodes to re-arm without letting a half-composed startup wake them. Bridge ownership is read live at mirror time and around its effectful calls rather than frozen at boot.
- **Feedback loops:** A missing or failed sink records one degradation on each eligible attempt. It does not enqueue through NotificationBatcher, so degradation reporting cannot recursively call the same missing sink. Permanent failure remains a rate-floored loop, registered as an Eternal Sentinel.
- **Recovery:** Successful script execution, successful prompt-session spawn, and successful completion all delete the alert episode. This re-arms a genuinely new failure episode without retaining stale backoff.
- **Existing flood controls:** Wider scheduler cadence acts before downstream Telegram flood controls. The fix therefore does not rely on flood suppression to hide a per-run producer.

---

## 6. External surfaces

- **Other agents/install base:** Every installation gets identical topology-independent handoffs. The same resolver covers desktop and laptop arrangements. No configuration change is required.
- **External systems:** Telegram may receive scheduler failure alerts that were previously silent, including jobs already beyond threshold. The first eligible alert is immediate; further traffic is bounded by the declared cadence.
- **Persistent state:** One JSON state record per currently or previously failing job is created under the existing generic StateManager namespace. Recovery deletes it. There is no schema migration and older versions safely ignore the keys.
- **Timing:** Scheduler-owned timers wake failed delivery retries at 5 minutes, 15 minutes, then a 1-hour cap. Delivered unresolved reminders wake at 1 hour, 6 hours, then a 24-hour cap. Exact boundary behavior is tested immediately before and at eligibility without manually invoking the alert callback.
- **Operator surface:** No operator-facing action is added. The user receives ordinary Telegram alerts; no dashboard form, approval, grant, or laptop-only action is introduced.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** — the persistent record describes attempts made by the currently executing scheduler owner through that machine's configured delivery adapter. Delivery success or failure is a machine-specific transport fact and must not be copied blindly to a peer whose adapter may have different reachability. Existing scheduler-awake selection plus job claim/lease ownership is the one-voice gate: only the machine that owns the failed job run can enter its alert path, and every laptop/desktop startup arrangement passes through the same topology resolver and send-side composition seam. Threadline bindings remain in their existing coherence path; the bridge's live predicate requires both awake role and held lease for every mirror, so role handoff changes the active voice without server reconstruction.

It emits user-facing Telegram notices, so one-voice matters and is provided by existing scheduler ownership rather than a second notification-specific election. It holds durable local state that survives process restart on the same owner. On machine ownership transfer the old cadence record does not transfer; the new owner can emit one immediate takeover-context alert, then follows the same bounded cadence. It creates no URLs and has no topic-transfer state.

---

## 8. Rollback cost

- **Hot-fix release:** Revert the composition helper, scheduler state machine, sink reporter adoption, and tests, then publish the next patch. This restores the old exact-threshold behavior and its known send-only gap.
- **Data migration:** None. New StateManager keys are ignored by older code and can remain until a later successful run or manual housekeeping removes them.
- **Agent state repair:** None required. Rollback does not change job definitions, Telegram credentials, topic mappings, or database schema.
- **User visibility:** During rollback propagation, send-only schedulers can again miss alerts and over-threshold jobs can remain silent. Already delivered Telegram messages remain visible.

---

## Conclusion

The first review found that bounded state alone did not wake retries, a mode label did not prove production topology selection, and the moved Threadline bridge lacked a standby one-voice gate. The first revision added scheduler-owned rehydrated timers, a production topology resolver exercised for four arrangements, and a bridge owner declaration. The second read then caught pause-expiry loss and boot-frozen bridge ownership; the next revision re-armed overdue episodes on scheduler resume and made every bridge mirror consult live role plus lease. The third read found that activation still equated composition completion with sink presence, so missing-sink episodes could disappear after restart or pause. The third revision separates those states, finalizes composition on the no-Telegram path, and pins no-sink reconstruction and resume behavior. It also records the irreducible remote-send/local-state crash window and the deliberate one-alert possibility when scheduler ownership transfers machines. The fourth cold read concurred after independently verifying production finalization, configured- and missing-sink lifecycle convergence, pre-finalization silence, live bridge ownership, and all four startup arrangements.

---

## Second-pass review (if required)

**Reviewer:** `scheduler_alert_side_effect_review`
**Independent read of the artifact:** `concur — fourth revision`

First-pass concerns and resolutions:

- The cadence had no scheduler-owned wakeup. Resolved by persisting the last failure context, scheduling one timer per episode, rehydrating after full send-side composition or pre-wired scheduler start, and cancelling on stop/recovery. Tests now advance the real fake clock without manually reinvoking the alert method.
- The test passed a hand-authored mode label. Resolved by factoring the production topology resolver and composing all four resolver outputs through the real adapter/scheduler/batcher seam.
- Standby could become a second stateful Threadline mirroring voice. The initial boot-time gate was superseded by the stronger live-owner predicate described below; the topology matrix still pins standby's initial `bridgeOwner: false` posture.

Second-pass concerns and resolutions:

- A timer expiring while the scheduler was paused was deleted without a wakeup. Resolved by reactivating all persisted episodes in `resume()`; a fake-clock test advances through the due time while paused, proves silence, resumes, and proves one immediate re-armed delivery.
- Bridge ownership was a boot snapshot. Resolved by constructing the bridge as a promotion-ready observer and injecting a live `coordinator.isAwake && coordinator.holdsLease()` predicate. Both inbound and outbound mirrors fail closed when it is false, and the handoff test changes owner state without rebuilding the bridge.

Third-pass concern and resolution:

- Missing-sink retry activation was still conditional on a sink existing. Resolved by tracking composition completion independently, calling the activation seam unconditionally after production topology composition, and adding fake-clock reconstruction plus pause→due→resume tests for a scheduler with no sink.

Fourth-pass verdict:

- **CONCUR.** The reviewer independently re-ran the focused safety suite (200/200), TypeScript, and diff checks. No unresolved side-effect concern remains.

---

## Evidence pointers

- `tests/integration/server-telegram-send-side-composition.test.ts` — production topology resolution plus real-adapter composition for explicit send-only, standby laptop, Lifeline-polling owner, and server-polling owner, plus structural branch sweep, unconditional alert-delivery finalization, and bridge ownership.
- `tests/unit/job-failure-alert-escalation.test.ts` — count 253, timer-owned failed-delivery backoff, timer-owned successful reminder cadence, configured- and missing-sink reconstruction/resume rehydration, stop/recovery cancellation, recovery/send race, exclusive sink, and overlap.
- `tests/unit/TelegramBridge.test.ts` — live awake-owner → standby → owner handoff without bridge reconstruction.
- `tests/unit/notification-batcher.test.ts` — loud missing and throwing sink behavior.
- `tests/unit/self-action-convergence.test.ts` with `src/testing/selfActionRegistry.ts` — permanent-failure rate floor and restart posture.
- `.instar/roadmaps/scheduler-alert-delivery-contract.md` — acceptance contract frozen before implementation.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action`
- **`closure`** — `guard`
- **`guardEvidence.enforcementType`** — `ratchet`
- **`guardEvidence.citation`** — `tests/unit/self-action-convergence.test.ts`
- **`guardEvidence.howCaught`** — The scheduler notification is a self-triggered control-loop edge under permanent delivery failure. The registered Eternal Sentinel fixture persists its attempt count and next-eligible time across reconstruction, drives the higher-frequency adversary, and requires at least five minutes between emissions while the real controller widens to a one-hour retry cap; a bare at-or-past-threshold alert on every job run would violate the ratchet's rate-floor assertion.
