# Side-effects review: refresh the Conversations list when a sheet closes after a change

Tier 1. One dashboard file and its test, about 20 lines. One commit attempt so far. Conversations stays off by default.

## Summary

Closing the create or rename sheet with × after a saved change left the list stale until the owner navigated away. Now the list refreshes once when a sheet closes after a change, by × or by Done. Closing with nothing changed does not refresh. The new test failed before the fix.

## 1. Over-block
No issue identified: this blocks nothing.

## 2. Under-block
An owner lock during an open sheet skips the refresh, and the unlock path reloads the view instead.

## 3. Level-of-abstraction fit
The sheet owns its change state and already takes a `refresh` callback, so this is the right layer.

## 4. Signal vs authority compliance
No decision point. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions
Done no longer refreshes twice: it relies on the close handler when a change happened, and still refreshes itself for flows with no change.

## 6. External surfaces
Dashboard only. One extra read of the list after a change.

## 6b. Operator-surface quality

Checked on a real CLI server in headless Chromium: create, name and open at 390 wide in dark, and 320 and 1280 wide in light; forget name at 390 wide in light.

1. Leads with the primary action: yes. "Create effort" is on the first screen, and the sheet's own action is its only primary button.
2. Zero raw internals as primary content: yes. Efforts show their names or "Untitled".
3. Destructive actions de-emphasized: yes. "Forget name" sits under More, last, and opens its own sheet stating the effect before confirming. It has the same button weight as Rename once More is open.
4. Plain language and phone width: yes. No sideways scroll at 320, 390 or 1280.

## 7. Multi-machine posture
Machine-local by design: this is browser view state. The refresh reads through the existing owner routes.

## 8. Rollback cost
Revert the file. No state involved.
