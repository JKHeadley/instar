# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Adds a testable exact binding for a future one-time Threadline send from an authenticated owner request.

## What to Tell Your User

This is test preparation. Threadline asks and sends as before.

## Summary of New Capabilities

No new live capability. The test-only reservation ties one attempted send to the exact owner request.

## Evidence

Focused tests distinguish changed text, message source, exact paired destination, thread, reply target and delivery ID.
