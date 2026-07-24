# Side-Effects Review — Session-pool self-placement confirmation

**Version / slug:** `session-pool-self-placement-confirmation`
**Date:** `2026-07-17`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `continuation_impl_review` (independent Codex reviewer) — CONCUR after two correction rounds

## Summary

Successful local session delivery now confirms a self-owned `placing` row as
`active`. Confirmation remains outside `SessionRouter`, after the real local
inject/spawn seam. Failed spawns do not confirm.

## Decision-point inventory

- Post-local-delivery ownership transition — **modified** — a successful local
  tail may confirm only its own still-placing row.

## 1. Over-block

No message is newly blocked. Missing, active, or remotely-owned rows are no-ops.

## 2. Under-block

The transition cannot run before delivery because every callsite is after a
synchronous injection that returned true or inside a spawn/respawn success
continuation. A rejected injection or spawn does not confirm.
Registry confirmation failure is diagnostic-only after delivery and cannot fall
into the delivery-failure handler. If the transition commits but observer
emission fails, the committed outcome remains true and diagnostics avoid
claiming an unknowable row state.

## 3. Level-of-abstraction fit

The state predicate is a small pure core. Server wiring owns the timing because
it alone knows when the legacy local delivery tail has actually succeeded.

## 4. Signal vs authority compliance

The ownership registry remains the sole transition authority. Local delivery
success is evidence supplied to that authority, not a parallel ownership store.

## 4b. Judgment-point check

No heuristic is introduced. The enumerable rule is `status=placing AND
owner=self AND local delivery succeeded`.

## 5. Interactions

Ordinary traffic to an active local session calls the helper but performs no
write. Remote placement confirmation remains unchanged. SpawnAdmission still
runs before every local spawn and a refusal cannot reach confirmation.

## 6. External surfaces

`GET /pool/ownership-view` now reports `active` after a successful self-placement.
No schema, authentication, configuration, or user command changes.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated.** The transition is written to the existing ownership registry
and propagated by its existing replication path. A live laptop/Mini test proved
the receiving Mini's row reached `active`.

## 8. Rollback cost

Pure code rollback with no migration. Rollback restores stuck `placing` rows
for new self-placements.

## Evidence

- `tests/unit/SessionPoolLocalClaim.test.ts`
- `tests/unit/session-pool-activation-wiring.test.ts`
- `tests/integration/session-pool-local-claim.integration.test.ts`
- `tests/unit/no-silent-fallbacks.test.ts` (both contained error paths are
  explicitly annotated and continue to report through `onError`)
- Live single-agent CROSS-MACHINE topic 3462 placement: owner Mini, epoch 2,
  status `active`.

## Conclusion

The change is narrow and preserves honest failure semantics. It should ship
with the independent session-lifecycle second pass concurred.

## Second-pass review

The first pass found that live injection's boolean result was ignored and that
confirmation exceptions could falsely enter delivery-failure handling. Both
were fixed and regression-tested. The second pass found a post-commit honesty
edge: observer emission could throw after CAS committed while diagnostics
claimed the row remained placing. The authoritative CAS result is now separate
from best-effort observation; committed confirmation stays true, diagnostics
make no unverified state claim, and the observer-failure regression is pinned.
The reviewer then concurred with no remaining findings.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect or self-triggered controller is added or
modified — not applicable.
