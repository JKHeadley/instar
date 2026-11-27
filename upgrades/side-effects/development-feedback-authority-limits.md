# Side-Effects Review — Development feedback authority limits

**Tier:** 1
**Author:** Echo
**Second-pass reviewer:** Not required for display and read metadata.

## Summary of the change

Development uses read-only metadata from the existing readiness and triage proposals to label subscription and metered limits. The readiness projection uses the same per-batch reservation estimate that the runner uses. Configured daily calls and the existing shared account pause threshold come from triage.

## Decision-point inventory

The serving route affects visible wording and fields. Existing PIN, authority binding, model identity, spending reservations, quota admission, and registration pass through their current authorities.

## 1. Over-block

There is no new admission decision. Unverified routes omit the USD editor. The current proposal value remains in the request when that editor is hidden.

## 2. Under-block

There is no new admission decision. The UI distinguishes an account-wide pause threshold from a dedicated allowance share. The readiness limit is approximate because the counter tracks batches and uses a fixed estimate.

## 3. Level-of-abstraction fit

The server reports backed limits for its own serving routes and the console renders them. The console skips dollar wording when the response lacks affirmative metered-route metadata.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The projections describe existing controls. [Signal vs Authority](../../docs/signal-vs-authority.md)

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The current route preview resolves CLI doors and the proposal annotates the existing subscription doors when this machine serves the workload.

## 5. Interactions

The approval sheet uses the same presentation as the card. Preview reads retain the original envelope values and use the route metadata for wording. No new scheduled work, state, or message delivery is introduced.

## 6. External surfaces

The authenticated proposal GET endpoints gain additive limits metadata. The POST shape and existing legacy proposal text remain compatible.

## 6b. Operator-surface quality

The approval title and plain-language explanation lead the card. The daily call count and account threshold are readable with no technical view open. The model binding and editable limits sit in the collapsed detail area. Revoke remains in settings. The phone and desktop Chromium captures show the controls and the text at 390 and 1280 pixels.

## 7. Multi-machine posture

Machine-local by design. Billing-mode metadata is conservative outside the serving owner. A different machine’s route cannot be inferred from the serving route preview on this machine.

## 8. Rollback cost

Revert the source change. There is no migration, persisted capability, or authority state to repair.

## Evidence

The browser fixture checks subscriptions and the metered presentation at both requested viewport widths. HTTP tests check the actual serving feedback routes, including the unavailable route case.
