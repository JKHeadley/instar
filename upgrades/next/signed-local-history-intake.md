# Native local history intake transport

The internal router verifies native owner signatures over bounded exact bytes before handing them to the importer. It has no default service.

## What to Tell Your User

This build does not change how history is imported.

## Summary of New Capabilities

The private intake transport is available for a future importer mount.

## Evidence

Signed HTTP integration tests cover the dormant router, exact signed bytes and bounded exchange settlement.
