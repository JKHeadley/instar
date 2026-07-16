# Enrollment completion clears identity drift immediately

## What Changed

Successful account enrollment now invalidates the replaced slot's cached identity and immediately reverifies that account, rather than waiting for the next scheduled quota poll. The Subscriptions grid also keeps a fresh “Set up complete” result visible over a stale Needs sign-in snapshot during that short convergence window.

## What to Tell Your User

When you finish signing an account back in, its grid cell now settles immediately instead of briefly falling back to Needs sign-in. A fresh successful repair stays visibly complete while the account record catches up.

## Summary of New Capabilities

- Immediate targeted identity re-verification after enrollment completion
- Fresh completion state takes precedence over a stale Needs sign-in snapshot
- Existing active-cell success highlighting remains unchanged

## Evidence

- Unit coverage locks completed-state render precedence
- Integration coverage locks cache invalidation before targeted account polling
- Real-server E2E proves drift clears without waiting for a scheduled sweep
