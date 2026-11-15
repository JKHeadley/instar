# The Accounts screen knows about repairs on every machine

<!-- bump: patch -->

## What Changed

`GET /mobile/accounts` now reads every machine's sign-in repairs (the merged `/subscription-relogin?scope=pool` read it already used for blockers), not only the answering machine's. For an account that needs signing in, its latest repair on that machine sets the cell: "signing in now" while one runs, "automatic repair starting" for an unattended one about to start, "automatic repair will try again at <time>" while a slow retry is pending (not counted), and "automatic repair failed: <reason>", "needs your OK to repair" or "needs you to finish signing in" when the person is really needed (counted). The in-flight states now match the repair store's real state names.

## What to Tell Your User

The Accounts screen no longer says an account needs signing in while Instar is already fixing it on another machine. It says "signing in now", or when it will try again. When it does need you, it says why.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Repairs on every machine show on the Accounts screen | Automatic |
| A failed repair says why | Automatic |

## Evidence

2026-11-15 (topic 33890): the phone showed "3 need signing in" for three accounts on the Mac Mini while its automatic repairs had started there three times each; the Studio answering the phone could not see them.
