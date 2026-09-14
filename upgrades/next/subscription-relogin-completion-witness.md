# Sign-in repair no longer mistakes an old file for success

## What Changed

Claude sign-in repair now records an opaque, keyed revision of the account slot's auth material before a login starts. The automatic completion sweep only finishes the repair after that revision actually changes and the returned account identity matches. An existing `.claude.json` settings file is no longer treated as proof that a new login succeeded.

If the dashboard's short-lived operator approval has expired, tapping a repair action now opens the PIN screen directly. The user is told to enter the dashboard PIN and retry, instead of being left with the unactionable instruction to “unlock the dashboard again.”

The internal auth revision never contains credential bytes and is removed from local, pooled, reissue, start, reuse, completion, expired-login, and peer-facing HTTP responses. Concurrent completion sweeps are serialized by pending-row version, and a failed pool finalization stays pending for a safe retry rather than reporting success.

## What to Tell Your User

Sign-in repair now waits for a real credential change before reporting success. If dashboard approval has expired, the repair button reopens the PIN prompt so the user can continue in place.

## Summary of New Capabilities

- False completion is prevented even when an old Claude settings file already exists.
- Locked repair controls can reopen the existing dashboard unlock flow.

## Evidence

- Unit, integration, and production-composition E2E coverage exercises changed, unchanged, missing, legacy, and unreadable auth revisions plus the locked dashboard action.
- The focused regression suite passes 276 tests across 7 files and the TypeScript production build completes successfully.
