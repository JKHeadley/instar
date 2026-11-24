<!-- bump: patch -->

## What Changed

Delayed Accounts sign-in steps and dialog timers now belong to the page and dialog that started them. A request already sent to a computer can still finish. Visible account buttons continue to work while the list refreshes.

## What to Tell Your User

If you leave Accounts while a computer is starting or repairing a sign-in, your new page keeps its own dialogs. You can return to Accounts to see the latest result.

## Summary of New Capabilities

There is no new setting or action. This repairs the existing Accounts flow.

## Evidence

All 64 focused Accounts checks and 66 existing renderer checks for the shared PIN prompt passed. The 11 configuration route checks and one production server lifecycle check also passed. The local build succeeded.
