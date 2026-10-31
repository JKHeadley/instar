# Bounded quota-enforcement pause

<!-- bump: patch -->

## What Changed

Quota enforcement now gives its scheduler pause a five-hour deadline. Recovery can release it sooner, and repeated enforcement keeps the original deadline. The pause reason, start, and deadline are visible in `/quota/migration`. After a deadline release, AI jobs wait for a fresh healthy reading while script checks run; `awaitingFreshQuota` makes this visible. Notifications describe both release paths.

## What to Tell Your User

If a usage-limit brake stops scheduled work, it releases when usage recovers or after five hours without recovery. After a deadline release, script checks run again, and AI jobs wait for a healthy usage reading.

## Summary of New Capabilities

`/quota/migration` reports an active enforcement pause and its deadline, then reports whether AI jobs are waiting for a new reading. The scheduler self-releases at the deadline so script checks can run.

## Evidence

Unit tests cover deadline, recovery, and repeated enforcement. Integration and lifecycle tests cover notifications, migration status, and a real scheduler. The full suite and CI remain merge gates.
