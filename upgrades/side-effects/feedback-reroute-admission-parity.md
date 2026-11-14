# Side-Effects Review — feedback reroute admission parity

**Version / slug:** `feedback-reroute-admission-parity`  
**Date:** 2026-11-04  
**Author:** Echo  
**Second-pass reviewer:** independent reroute-lifetime reviewer

## Summary of the change

The feedback executor asks `SessionManager.confinedRerouteCapacity()` before claiming a ranked item. Its canary and worker sessions are not scheduler-proven, but the precheck counted a slot reserved for scheduled jobs. At five of six rerouted sessions, a live tick claimed a priority-95 retry and prepared a workspace; the canary was then refused at its actual `5/5` limit. `src/core/SessionManager.ts` now applies the same non-scheduler global cap and shared reroute admission cap at the precheck and spawn gate. Two unit test files cover both sides of the reservation. No new slot is granted.

## Decision-point inventory

- `confinedRerouteCapacity()` — modified — returns saturation before the feedback executor claims work.
- `evaluateRerouteGate()` — modified to share the cap helper; its existing spawn authority and scheduled-job exception remain.
- Feedback executor ranked selection and independent review — passed through without change.

## 1. Over-block

At five of six rerouted sessions, a feedback worker now waits even if the sixth slot is idle. That is intended: the sixth slot is reserved for a scheduler-proven job, and the feedback worker's canary would otherwise be refused. A one-slot host retains its full single slot, so it is not blocked by a reservation it cannot spare.

## 2. Under-block

The precheck is a snapshot. Another session can take the last available place before the canary starts; the spawn gate still refuses it. Memory pressure can also change between the two checks. This patch does not add a reservation or a worker queue and cannot guarantee an immediate start.

## 3. Level-of-abstraction fit

The precheck is an early resource-capacity signal for the executor, while the spawn gate remains the final authority. Both use the same `SessionManager` counters and cap helper. A separate executor-side copy of the limits would drift again.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

This is a deterministic resource safety invariant: the non-scheduler worker cannot spend the scheduler's reserved slot. The early check feeds the executor's admission decision; the existing spawn gate continues to enforce the hard limit. No judgment about a report's meaning, priority, or user intent is added.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The available slot count and scheduler provenance are enumerable resource facts defined by the approved confined-spawn spec. Triage ranking remains the model-governed decision point.

## 5. Interactions

- **Shadowing:** the precheck runs before the canary and prevents a known futile claim; the canary still runs when the precheck says available.
- **Double-fire:** no new action fires; both checks read the same session state.
- **Races:** a concurrent spawn can still take the slot between checks; the spawn gate refuses safely.
- **Feedback loops:** repeated capacity ticks can stay idle until a slot frees. No retry budget or ranking changes.

## 6. External surfaces

The executor may claim fewer feedback items during capacity pressure and records `admission:reroute-capacity` instead of claiming then stopping at canary. No API shape, secret handling, Telegram delivery, or durable schema changes. A deployed agent receives the code through the ordinary Instar update path. The fix queue continues to grow while all worker slots are occupied.

## 7. Multi-machine behavior

**Machine-local by design:** session slots and memory pressure are facts about the machine that would run the canary; each host must read its own counters. The drain owner still controls the single executor writer. This change emits no new user-facing notice, stores no new state, and generates no URL.

## 8. Rollback cost

Revert this code change and ship a patch. No migration or state cleanup is needed. During rollback, the old false admission can recur under the reserved-slot boundary; the spawn gate still refuses the unsafe start.

## Conclusion

The change aligns the early feedback admission with the final spawn guard and preserves the scheduler reservation. Build, full unit suite, focused real-manager tests, and exact-head three-tier verification at `39400fb38` passed. The live receipt after deployment remains required. The original commit lacked a decision-audit record; this review and a new gated commit will repair that evidence gap before merge.

## Second-pass review

**Reviewer:** independent reroute-lifetime reviewer  
**Independent read of the artifact:** concur. The reviewer checked the 1-slot and 2-slot boundaries, the scheduler exception, the global overflow test, and the residual race. The existing spawn gate remains authoritative. The reviewer noted that the older precheck already returned `saturated` at the global max before checking mode; this patch preserves that order and aligns it with the final global gate.

## Evidence pointers

- Approved spec: `docs/specs/confined-spawn-subscription-reroute.md`.
- Focused real-SessionManager tests: 65 passed; executor capacity tests: 7 passed.
- Exact-head local verification at `39400fb38` against main `7840c5ff`: unit 3,121 files / 57,051 tests, integration 675 / 5,507, E2E 499 / 3,746; zero failures.
- Live pre-fix refusal: feedback canary at `5/5`, with no worker session launched.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect. This changes an early capacity query and a shared cap calculation; it does not add or modify a self-triggered controller's action, cadence, or retry edge. The existing executor tick remains bounded by its previous limits.
