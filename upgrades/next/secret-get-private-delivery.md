# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Vault lookups now require a designated consumer. A bare lookup stops before opening the vault, and the helper suppresses the consumer's stdout and stderr. Array fields can be addressed individually.

## What to Tell Your User

Use the vault helper's explicit command mode to pass one value to the program that needs it. Use the names option to see which fields are available.

## Summary of New Capabilities

Single-field secret transfer supports indexed paths. Built-in callers use a dedicated private pipe when they need the value in their own process.

## Evidence

Disposable fixtures check bare lookup refusal, individual array values, suppressed consumer output, configuration fallback and metered key refusal.
