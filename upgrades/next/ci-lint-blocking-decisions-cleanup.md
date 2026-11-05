<!-- bump: patch -->

## What Changed

A unit test for the blocking-decision lint now removes the one fixture file it writes, instead of leaving it behind and failing on main when the safe-delete guard refused the cleanup.

## What to Tell Your User

Nothing to tell. This is a test-only fix.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| None | Test-only change |

## Evidence

The test failed before the fix with SourceTreeGuardError and left the fixture in src/templates/scripts; after the fix it passes and leaves nothing behind.
