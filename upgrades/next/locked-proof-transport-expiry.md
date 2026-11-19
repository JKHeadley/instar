## What Changed

The locked-screen proof reports missing expiry evidence for cases 15.5 and 15.6. It continues to report elapsed time between disconnect and duty closure.

## What to Tell Your User

A previous passing result for either case needs fresh evidence of when the server actually expired the connection.

## Summary of New Capabilities

Developers can now distinguish an unmeasured expiry from an early duty closure in the same report.

## Evidence

Two synthetic reproductions cover disconnects on both sides of Enter. Targeted unit tests also cover caller-supplied timing and early duty closure.
