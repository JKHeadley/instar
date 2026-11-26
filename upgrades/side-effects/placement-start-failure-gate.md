# Side-Effects Review — placement start-failure gate

**Slug:** `placement-start-failure-gate`
**Date:** `2026-10-20`
**Author:** Echo (autonomous, 24h run on topic 61449)
**Tier:** 1

## Summary of the change

Placement's eligibility signal (`computeSelfQuotaState`) had two causes — account
quota exhausted, llm-circuit open. A machine that cannot START a session had none
of the observable symptoms (no load, no sessions, untouched quota) and therefore
scored best. On 2026-10-20 the Mac Mini killed three sessions in 35 minutes at an
unanswered folder-trust dialog while holding the operator's conversation.

Adds a third cause: `SessionStartFailureTracker` counts consecutive startup deaths
in a 15-minute window and reports blocked at three; one successful start clears it.

## Decision-point inventory

No LLM decision points. The verdict is a deterministic counter against a threshold
with an injected clock.

## Blast radius

- `startFailureTracker.ts` — new, pure, no I/O, no timers, in-memory only.
- `selfQuotaState.ts` — one new optional parameter and one new `reason` value. With
  the parameter absent or null, behaviour is byte-identical (test).
- `SessionManager` — emits `sessionStartSucceeded` at the two existing ready
  points. Additive event; no existing listener is affected.
- `server.ts` — constructs the tracker, feeds it from the existing `sessionExited`
  handler, clears it on the new event, and reads it in the existing capacity
  heartbeat.
- `PlacementExecutor` — the pin escalation reason now distinguishes the cause. No
  change to which machine is chosen beyond what the eligibility flag already drives.

## Reversibility

Reversible by revert. In-memory state only: nothing durable is written, so a
revert leaves no residue and a restart already clears the counter.

## Failure modes considered

- **Wrongly excluding a healthy machine.** Requires three CONSECUTIVE startup
  deaths inside 15 minutes; any successful start resets to zero. A single crash, a
  resource blip, or an unrelated restart cannot reach the threshold. Worst case the
  machine sits out until its next successful start, which it re-admits itself on.
- **Excluding every machine.** The quota gate's existing all-blocked fallback
  applies: placement still places, with the reason carried (test).
- **Overriding the operator.** A hard pin is still honoured (test). The operator's
  explicit choice beats this signal, exactly as it beats the quota gate.
- **Alarm noise.** One attention item per episode, keyed on a fixed id, raised only
  on the transition into blocked — not per failure (wiring test).
- **A block that never lifts.** This was the real risk, and it is why
  `sessionStartSucceeded` is emitted rather than inferred: without a positive
  clearing signal the gate would be worse than the bug. Covered by a test asserting
  one success zeroes the count.
- **Mislabelling the cause to the operator.** The escalation reason now says
  `pinned-machine-cannot-start-sessions` rather than reporting quota trouble about
  a machine whose logins cannot answer a dialog.

## Verification

17 new unit tests (`tests/unit/start-failure-placement.test.ts`): both sides of the
threshold, the clearing signal, window expiry, read-purity, a configurable
threshold, the new cause through `computeSelfQuotaState` with a clean quota and an
available circuit, the placement outcomes (healthy pick, all-blocked, honoured
pin), and wiring integrity for every seam. Existing `PlacementExecutor` (35) and
`selfQuotaState` (8) suites green. Full lint clean. `tsc --noEmit` clean.

## Class-Closure Declaration

**Defect class:** `unbounded-self-action`
**Closure:** `n/a`
**Reason:** the tracker takes no action. It is a counter whose state is read by the
existing capacity heartbeat; it starts nothing, kills nothing, and schedules
nothing. The only action in the change is one attention item raised once per
episode on a state transition, guarded by the transition check itself
(`!before && after.blocked`) and deduped on a fixed id.
