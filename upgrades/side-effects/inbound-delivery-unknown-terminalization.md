# Side-Effects Review — Inbound delivery unknown terminalization

**Version / slug:** `inbound-delivery-unknown-terminalization`
**Date:** `2026-09-04`
**Author:** `Codex`
**Second-pass reviewer:** `Codex independent reviewer`

## Summary of the change

`InboundDeliveryStore.markObservationUnknown` and `markRolloutUnknown` now transition uncertain dispatched evidence to terminal `effect-unknown`, and status reporting prioritizes that transport state. This releases finite live-row capacity without replaying or deleting uncertain evidence. Unit regressions cover saturation, single-row and shared-rollout terminalization, metrics, and renewed admission.

## Decision-point inventory

- `InboundDeliveryStore.markObservationUnknown` — modify — completes the observer's existing deadline decision with the correct terminal transport state.
- `InboundDeliveryStore.markRolloutUnknown` — modify — terminalizes every affected row when shared rollout parsing becomes uncertain.
- `InboundDeliveryStore.status` — modify — reports effect uncertainty from transport truth rather than shadowing it with eligibility.

## 1. Over-block

No new rejection is introduced. A delivery is terminalized only where the existing observer already chose unknown, either at its fixed deadline or after a rollout-integrity failure. It cannot later be automatically recognized as consumed, but that was already true because unknown eligibility excluded further observation/recovery.

## 2. Under-block

Stale `prepared` rows are not changed; four exist locally but remain well below capacity and may still be eligible for dispatch. Other nonterminal states continue to count as live by design.

## 3. Level-of-abstraction fit

The store owns transport-state transitions and admission accounting, so it is the correct layer. The observer still owns when evidence becomes unknown; the store only makes that existing verdict internally consistent.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this is mechanical state consistency after an existing authority decision.

No content or intent judgment is added. The deadline and observer already authorize the unknown result; this change ensures all state dimensions encode it consistently.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new heuristic or competing-signals decision point is added. This is an invariant: non-replayable observation-unknown evidence cannot simultaneously remain live for admission accounting.

## 5. Interactions

- **Shadowing:** status now exposes transport uncertainty before eligibility labels, correcting the prior shadow.
- **Double-fire:** the guarded SQL transition only matches dispatched/open rows, so repeated observer calls are idempotent.
- **Races:** each SQLite update is atomic; the shared-rollout transition updates all matching rows in one statement, so concurrent admission cannot see a partially terminalized rollout.
- **Feedback loops:** terminal rows enter existing bounded GC; they cannot be replayed or re-observed.

## 6. External surfaces

New Telegram messages can again enter sessions after prior evidence expires. Diagnostics report a larger honest uncertain-effect count. No message text, operator action, URL, or external API schema changes.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator UI surface is changed; not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** each machine's journal records physical terminal effects performed on that machine. Ownership transfer already fences/export-imports live rows; terminal unknown rows do not transfer or replay. No user-facing notice, durable topic-transfer obligation, or URL is added.

## 8. Rollback cost

Revert and deploy a patch. The terminal state is safe and retained; no reverse migration is required. The one-time local repair has a complete SQLite backup at `.instar/state/inbound-delivery.pre-terminal-fix-20260904.sqlite`.

## Conclusion

The first independent pass found that shared-rollout uncertainty had the same stranded-live defect. That path now terminalizes all matching rows atomically and has a multi-row capacity regression. The change restores capacity without weakening no-duplicate delivery semantics or deleting audit evidence; it is ready after confirming review.

## Second-pass review (if required)

**Reviewer:** Codex independent reviewer
**Independent read of the artifact:** concur — both single-delivery and shared-rollout uncertainty now terminalize atomically, preserve no-replay evidence, and release live capacity without adding judgment authority.

## Evidence pointers

- `tests/unit/InboundDeliveryStore.test.ts`
- Live diagnosis: 500/500 rows expired; 496 were dispatched+unknown but counted live.
- Local migration: 496 rows moved to effect-unknown; live count reduced from 500 to 4.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered action added — not applicable.
