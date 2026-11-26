# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Vault lookups can deliver one field directly to a designated consumer. The helper suppresses the consumer's stdout and stderr. Array fields can be addressed individually. Existing scalar pipe captures still work during migration and receive a deprecation notice.

## What to Tell Your User

Use the vault helper's explicit command mode to pass one value to the program that needs it. Use the names option to see which fields are available. Update custom scalar captures to explicit delivery before the later cutoff.

## Summary of New Capabilities

Single-field secret transfer supports indexed paths. Built-in callers use a dedicated private pipe when they need the value in their own process.

## Evidence

Disposable fixtures check legacy scalar capture, terminal or file output refusal, individual array values, suppressed consumer output, configuration fallback and metered key refusal.
