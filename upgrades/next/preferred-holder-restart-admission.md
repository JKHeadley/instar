<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Added dark request-bound planned-restart readiness evidence to the existing lease authority. An earlier renewal confirmation cannot stand in for a later unconfirmed nonce.

## Evidence

The focused boot-path test checks the exact acknowledged renewal and refuses a changed request, insufficient remaining time, or a newer unconfirmed nonce.

The dark supervisor path can leave a planned restart request pending until its exact lease window is confirmed. Role-change and explicit bypass requests keep their current behavior.
