# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed
The web Accounts page shows one continuous full-width column across services, with each row labelled by service. Known future weekly resets sort soonest first; missing or expired weekly resets follow, with stable name ties. Five-hour limits remain visible without controlling order. The scoped list layout remains single-column alongside the pending full-width dashboard styles. Account selection, sign-in actions, warnings and quota measurements are unchanged.

## What to Tell Your User
Accounts is now one list, with the account whose weekly allowance resets soonest at the top. Each account still shows its service, five-hour and weekly usage, and the machines where it is available.

## Summary of New Capabilities
None — this changes the layout and default ordering of the existing Accounts page.

## Evidence
Fifty focused unit tests, four HTTP integration tests, three production lifecycle tests, the build and sixteen normalChrome sample-data preview cases pass. The previews cover phone/laptop/wide, both themes, pending full-width CSS and measured25%largertext. The old source fails14of15newcases;all15passwiththerepair. Independentreviewconcurs. Complete shared verification and released live checks remain required.
