# Secret store: key names are checked before they are followed

## What Changed

The encrypted secret store addresses secrets by dotted names (for example `telegram.token`). Names reach it from several callers, and a name could contain a segment that refers to JavaScript's built-in object machinery rather than to stored data. Following such a segment touched shared process state instead of the vault's own contents, and reading a built-in name returned a JavaScript function instead of "no such secret".

The store (`src/core/SecretStore.ts`) now refuses a write whose name contains `__proto__`, `prototype` or `constructor` as a segment, reads such names and other inherited names as absent, treats a delete of one as a no-op, and follows only the vault's own stored keys. A write through a stored `null` or plain value now replaces it with a nested group instead of throwing. Found by the standing security review; triaged hardening.

## What to Tell Your User

Nothing changes for you. This is a behind-the-scenes hardening of how your agent stores its passwords and keys. No real secret uses the refused names, so every existing secret reads and saves exactly as before.

## Summary of New Capabilities

- Hardened dotted key-path handling in the secret store: reserved segments are refused on write and read as absent; only own stored keys are followed.

## Evidence

8 new unit tests in `tests/unit/secret-store.test.ts` (6 fail on the old code, all pass with the fix); 93/93 across the five secret-store and secret-sync test files; 0 type errors.
