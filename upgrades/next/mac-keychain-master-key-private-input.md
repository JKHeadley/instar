# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The macOS vault keychain writer sends the key through the Security tool's standard input. Instar checks the slot before it treats the write as successful.

## What to Tell Your User

Vault master keys stay out of the process command line during macOS keychain writes.

## Summary of New Capabilities

Per-agent and shared vaults use the same private input path on macOS.

## Evidence

Mocked checks cover input-only delivery, exact readback, rejected command separators, and fallback diagnostics. No production keychain items were written during verification.
