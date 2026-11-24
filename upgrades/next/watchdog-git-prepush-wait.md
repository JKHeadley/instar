<!-- bump: patch -->

## What Changed

The session watchdog recognizes when a Git HTTPS connection is waiting for
the same push's pre-push checks to finish.

## What to Tell Your User

Long pre-push checks can finish while Git keeps its connection open.

## Summary of New Capabilities

The watchdog attributes this wait automatically.

## Evidence

The watchdog integration regression models the transport and hook as siblings.
