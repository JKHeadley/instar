# Locked-screen Enter persistence

## What Changed

The native password helper now refuses Enter if its exact owed relock record is missing, belongs to a different request or producer, is already relocking, or cannot be saved. Both validation and atomic replacement must succeed. Existing cancellation and field-clearing behavior stays in place.

## What to Tell Your User

A locked-screen password submission stops safely if its relock record cannot be saved. Locked-screen access still requires the existing hardware proof before it can be enabled.

## Summary of New Capabilities

No new operator action or permission. This tightens an existing safety check.

## Evidence

Exact production Swift boundary compiled and executed with inert storage/dispatch callbacks; failures suppress Enter and valid retries preserve unrelated state. The real DirectDesktopAccess refusal path is tested separately. Common native helper typecheck passed. No real Mac password, lock action, installation or permission operation was performed. Full suites belong to Local Verify; P15 is not claimed passed. Atomic replacement is same-boot persistence, not an fsync/power-loss guarantee, and the existing check/post race remains.
