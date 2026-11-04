<!-- bump: patch -->

## What Changed

Two pool readings now say only what they know. The readiness report names the platform a machine cannot serve, and a manual move that timed out says the move may still land instead of saying it did not move.

## What to Tell Your User

Nothing to tell: two status messages are clearer.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Clearer pool readings | `GET /session-pool/readiness`, `POST /pool/transfer` |
