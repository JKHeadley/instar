# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The native Accounts read now includes an opaque grouping key for each machine with an account slot, along with the existing sign-in status for that slot. This lets the Mac app group Accounts by machine even when two machines have the same name.

## What to Tell Your User

An updated Mac app can group your accounts by the machines that actually have them. Existing app versions continue to show Accounts the same way.

## Evidence

Focused verification passed all 49 unit tests, 18 signed HTTP integration tests, and one production native Accounts lifecycle test. The signed HTTP coverage verifies that the grouping key appears on a real slot and raw IDs stay out of the response.
