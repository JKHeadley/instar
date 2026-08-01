# Side-Effects Review — learning velocity counts absorbed corrections

**Version / slug:** `learning-velocity-corrections-count-finishing`
**Date:** `2026-07-31`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`GET /metrics/learning-velocity` previously turned every correction-ledger detection into a learning event at `detectedAt`. It now admits only `verified` correction learning at `updatedAt`, coalesces records sharing one durable `routeClusterId` into one event, and returns explicit correction accounting. The pure scorer is unchanged; only event gathering in `src/server/routes.ts`, one explanatory comment in `src/core/LearningVelocityScorer.ts`, and the route tests change.

## Decision-point inventory

- `GET /metrics/learning-velocity` event gathering — **modify** — changes which correction records are reported as completed learning events.
- No block, allow, dispatch, lifecycle, or mutation decision is added. The metric remains read-only and advisory.

## 1. Over-block

No block/allow surface — over-block is not applicable.

The analogous reporting risk is over-exclusion. A useful correction that has not reached `verified` does not count, even if a human believes it taught the agent something. That is intentional: detection, routing, and attempted application are intermediate states, not proof that learning completed. The response itemizes those states so the exclusion is visible rather than hidden.

## 2. Under-block

No block/allow surface — under-block is not applicable.

A false `verified` lifecycle state would still count as learning because this metric consumes the correction loop’s durable success state rather than independently re-verifying preference contents. That is the correct abstraction boundary: the correction loop owns verification, while this route owns counting. Existing correction lifecycle tests guard the state transition.

## 3. Level-of-abstraction fit

The route is the existing event-gathering layer. `LearningVelocityScorer` remains a pure calculator over already-admitted events and does not gain ledger semantics. The correction loop remains the authority on whether correction learning verified. This avoids duplicating preference inspection or recurrence logic inside a reporting endpoint.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Learning velocity is a signal. Nothing branches on its score, and this patch adds no authority. It consumes the correction loop’s existing verified lifecycle result and reports a stricter denominator.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. `status === "verified"` is the existing completed-success invariant owned by the correction loop, and `routeClusterId` is the existing identity for one routed external effect.

## 5. Interactions

- **Shadowing:** none. The route reads lifecycle results after the correction loop writes them.
- **Double-fire:** cluster members are deliberately coalesced by `routeClusterId`, preventing one promoted preference from appearing as several learning events.
- **Races:** the ledger read is a bounded snapshot. A cluster transitioning during the read can appear on the next request; the endpoint mutates nothing.
- **Feedback loops:** none. No code consumes the metric to change correction state.
- **Source failure:** an unreadable optional ledger leaves the endpoint alive and sets `corrections.sourceError: true`; the denominator is not silently presented as complete.

## 6. External surfaces

The JSON response gains a `corrections` accounting object and expands the human-readable `counting` rule. Existing score fields are unchanged. Users asking whether the agent is learning may see a lower, more honest score because detected-but-unabsorbed corrections no longer inflate it.

No operator-facing action is added. No dashboard form, approval, secret, URL, or outbound notice changes.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local by design.** The endpoint already measures the learning sources available to the serving agent instance. This patch preserves that posture and reads the same local correction ledger as before. It emits no user-facing notices, holds no new durable state, and generates no URLs. There is no topic-transfer or one-voice concern because the route is request/response observability only.

## 8. Rollback cost

Pure code revert and patch release. No schema, config, migration, persisted data, or agent state repair is required. Reverting would immediately restore detection-time correction counting on the next request.

## Conclusion

The change closes the second half of the filing-versus-finishing inversion without moving the scorer or correction authority. Detected rows count zero; a verified legacy row counts once; several verified records from one routed cluster count once; and source degradation is explicit. The review found no blocking, actuation, or multi-machine side effect.

## Second-pass review

Not required. This is a Tier 1 read-only metric correction with no gate, sentinel, lifecycle, dispatch, or outbound surface.

## Evidence pointers

- `tests/integration/learning-velocity-routes.test.ts`
- `tests/e2e/learning-velocity-lifecycle.test.ts`
- `tests/unit/LearningVelocityScorer.test.ts`

## Class-Closure Declaration

No agent-authored-artifact defect and no self-triggered controller change — not applicable.
