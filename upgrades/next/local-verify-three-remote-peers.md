# Upgrade Guide — vNEXT

## What Changed

Local Verify now reads up to three remote verifier entries from the coordinator configuration. Each configured peer has one test slot and must clear the existing load, verifier version, policy and signer checks.

## What to Tell Your User

The machine coordinating tests can now share full test runs with three other Macs. Each eligible Mac runs one test at a time.

## Summary of New Capabilities

Use up to four machines in one Local Verify pool, including the coordinator.
