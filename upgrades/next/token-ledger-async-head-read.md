<!-- bump: patch -->

## What Changed

The scheduled Claude TokenLedger scan waits asynchronously for file open, metadata, and fingerprint reads. It keeps the same descriptor for the existing payload scan after confirming the file's identity.

## What to Tell Your User

The agent can keep responding while the token ledger waits for slow transcript fingerprint reads.

## Summary of New Capabilities

The existing scan uses the updated reader automatically.

## Evidence

A held-read test verifies that the heartbeat stays active. It also checks shutdown during the read and exact counting after a same-size transcript replacement.
