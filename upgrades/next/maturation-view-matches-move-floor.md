<!-- bump: patch -->

## What Changed

The maturation ladder no longer offers a settings change for a switched-off feature that has no safe start setting. The ladder's view and the move route now read the same helper, so `GET /maturation/ladder` reports `move.kind: code` for those features and `POST /maturation/moves` refuses them the same way it always did. No refusal rule, registry entry, setting or feature state changed.

## What to Tell Your User

Nothing changes for you, and no feature was switched on. Your agent's feature review was sometimes offered a quick settings change that the system would then refuse. It now sees the real next step, which is a reviewed code change.

## Summary of New Capabilities

None. This corrects what a read-only view reports.

## Evidence

On 2026-11-06 the feature review got opinions from two model families to start `monitoring.principalCoherence`, then `POST /maturation/moves` refused it with `not-a-config-move` while the ladder showed a config move. The registry row has no `start`, and spec section 8 makes that refusal correct. A new test applies every shipped registry entry the view offers as a config move: before the fix it named `sessions.dynamicMcp` and `monitoring.principalCoherence`, after it names none.
