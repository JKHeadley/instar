# Sign-in Repair No Longer Loses an Account That Is Still Signed Out

## What Changed

An account could stay signed out with no automatic repair ever starting again. Its sign-in incident had been closed as "cancelled" when the account briefly dropped out of the poller's tracked set, and nothing reopened it, because a new incident opens only when an account changes from signed in to signed out. Now, when such an account is tracked again and the pool still marks it as needing sign-in, its latest cancelled incident is reopened as it was, with its original evidence, and a `relogin-reopened` event records it. The existing slow retry then resumes. A resolved incident is never reopened.

## What to Tell Your User

If one of your accounts was stuck as "needs sign-in" with no repair starting, I can now pick it back up by myself.

## Summary of New Capabilities

An account that stays signed out keeps its open sign-in incident, so its automatic repair can start again.

## Evidence

Mac Mini, gearfinity3d: incident 32 was closed "cancelled" at 2026-11-26 03:55:58Z while the account stayed signed out, and the slow retry of repair 07a05cb5 was unscheduled. The Laptop shows the same "no open incident" blocker. Unit tests are in tests/unit/relogin-reopen-cancelled-incident.test.ts.
