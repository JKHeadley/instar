<!-- bump: patch -->

## What Changed

- Closing, delivering or editing a promise by id (`POST /commitments/:id/deliver` and the other id-addressed commitment routes) no longer answers "ambiguous across machines" when the matches are copies of ONE promise. A rebuilt or restored machine can hold its own copy of a promise that started on another machine while that machine's replica holds the same record; before, the route refused even with `?origin=`, so a finished promise could not be closed at all and would later be reported as late. Now, when every match names the same origin, the copy published by that origin wins: the local record when the origin is this machine, otherwise the origin's replica, and the change is forwarded to the origin machine. Different machines that happen to reuse one id still answer 409 and still need `?origin=`. Merged rows from a replica now carry `replicaOwnerMachineId` (which machine's replica held the row). Fixes feedback `fb-6a8328a1-e98`.

## What to Tell Your User

When I finish something I promised, I can mark it done again even after one of your machines was rebuilt from a copy of another. Before, such promises got stuck open and could have been reported to you as late.

## Summary of New Capabilities

- Promises restored onto a rebuilt machine can be closed by id again; the close goes to the machine the promise started on.

## Evidence

Reproduced live on the rebuilt Mac Studio on 2026-11-20: its own store held 925 promises whose origin is the Laptop, the Laptop's replica held the same records, and `POST /commitments/CMT-2056/deliver?origin=<laptop>` answered 409 ambiguous. New integration and end-to-end tests reproduce the 409 on the old code and pass on the fix (200, forwarded to the origin; the stale local copy is left untouched); unit tests cover both collapse directions, the distinct-origin collision that must stay 409, and copies held only by third parties, which also stay 409.
