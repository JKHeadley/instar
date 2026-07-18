# Headless secret sync now keeps its configured durable key

## What Changed

Cross-machine secret sync now honors the agent's existing `secrets.forceFileKey` setting for both receiving and sending stores. A headless joined machine configured for file-backed key persistence can therefore reopen its synchronized vault after its server restarts, without depending on a different OS-keychain session context.

## Evidence

- A new production-wiring ratchet verifies both secret-sync stores inherit the configured key policy.
- The secret-sync round-trip and vault key-coherence suites pass together (20 targeted assertions).
- The originating two-machine throwaway canary retained mutation, tombstone, and symmetric-restart correctness while isolating this vault-key failure.

## What to Tell Your User

Secrets synchronized to a headless machine now remain readable after restart when that agent is configured to keep its vault key in its protected local state.

## Summary of New Capabilities

- Headless cross-machine secret receivers consistently honor their configured durable at-rest key backend.
