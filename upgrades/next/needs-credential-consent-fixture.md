<!-- bump: patch -->
<!-- internal-only -->
## What Changed

Adds an unmounted credential consent adapter and signed disposable fixture for Needs You. The adapter reuses an ordinary single-field Secret Drop behind current owner authorization. Its exact disclosure expires with a changed request binding. It does not register a production route.

## Evidence

The fixture tests signed submission, read-only field projection, replay, stale and restored assignments, expiry, tampered body and a revoked owner device.

A production-construction test verifies the fixture routes are absent from AgentServer.
