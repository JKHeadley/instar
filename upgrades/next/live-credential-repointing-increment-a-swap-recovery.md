# Upgrade Guide — Live credential re-pointing (Increment A, Step 5c)

<!-- bump: patch -->

## What Changed

Step 5c — boot-recovery for an interrupted credential swap, shipping **dark**. `CredentialSwapExecutor.recoverInFlight()` resolves any swap left in-flight by a crash or power loss; nothing wires it at startup until the feature is enabled, so there is zero runtime behavior change (and it is a no-op when no swap is in flight).

For each interrupted swap, under the same single-mover + per-slot locks a live swap uses, it verifies both slots against the intended end state by ACCOUNT IDENTITY and:
- both slots already correct → finishes it (frees the safety copy, marks done);
- both slots still in their original state → aborts cleanly (nothing moved);
- genuinely half-done (a crash between the two writes) → reconstructs the move from the retained safety copy + the live blobs (never overwriting a freshly-rotated login), re-verifies, and commits;
- can't be sure (the identity check is down, or a credential is missing) → quarantines that slot, keeps the safety copy, and flags it — never guesses.

This closes the crash-safety story the staging escrow + journal set up in 5a/5b, and handles the two partial-state cases the Step-5b safety review flagged.

## What to Tell Your User

Nothing changes for you right now — this is the safety net for the upcoming restartless rebalancing, still shipping switched off. It means that if the machine ever crashed or lost power in the middle of moving a login between slots, the next startup would automatically put things right: finish the move if it was basically done, undo it if it hadn't really started, or carefully rebuild it from the safety copy if it was caught halfway — and if it couldn't be certain, it would set that slot aside and tell you rather than risk a wrong guess. You won't see any of this unless something needs your attention, and the worst case is still a single "please log in again" with the correct account named.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Boot-recovery of an interrupted credential swap | Automatic (internal) — resolves any crash-interrupted move at startup |
| Half-done move reconstruction (adopt-on-newer) | Automatic (internal) — rebuilds from the safety copy without clobbering a rotated login |
| Quarantine-rather-than-guess on uncertainty | Automatic (internal) — an unverifiable slot is set aside + flagged, never trusted blind |

## Evidence

- 6 new unit tests (`credential-swap-recovery.test.ts`) over a keychain-backed oracle (so the partial-state transitions are exercised realistically): empty-journal no-op; committed→completes (frees staging); begin+pre-swap→aborts; exchanged+partial→re-drives to the intended state and commits; oracle-unavailable→quarantine+retain; a live swap holding the mutex→reported busy (retry next sweep).
- `npx tsc --noEmit` clean; the credential-write lint clean; the executor's 10 tests still green (16 swap tests total).
- Independent second-pass review of the destructive re-drive path — verdict recorded in the side-effects artifact.
