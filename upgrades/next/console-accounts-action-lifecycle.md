<!-- bump: patch -->

## What Changed

Delayed Accounts sign-in steps and dialog timers now belong to the page and dialog that started them. A request already sent to a computer can still finish. Visible account buttons continue to work while the list refreshes. Sort and group choices remain available when the list refreshes. The weekly forecast remains on the page.

## What to Tell Your User

If you leave Accounts while a computer is starting or repairing a sign-in, your new page keeps its own dialogs. You can return to Accounts to see the latest result.

## Summary of New Capabilities

There is no new setting or action. This repairs the existing Accounts flow.

## Evidence

On main base `98f2421a9`, 81 browser and model tests, 29 HTTP integration tests, and two production quota-forecast lifecycle tests passed. Full verification will run on the published commit.

The rebased combination on main `e965a2d32` passed 121 unit tests, 37 signed HTTP tests, three production lifecycle tests and six responsive browser cases.
