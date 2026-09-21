# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Autonomous-run setup and its stop hook resolved the local server's bearer token
by reading `config.json.authToken` inline. On vault-migrated agents that field
is the SecretMigrator placeholder, so every call from those scripts was refused
— and on an admission-enforcing install a new run sat `preparing` forever with
no message. Both scripts now resolve the token vault-aware (config string first,
else `secret-get.mjs`), a refused registration prints a clear error (fatal only
where admission is required to arm), and a pre-existing `pipefail`+`grep -c`
trap that could kill setup silently is fixed. Existing agents receive both
scripts through PostUpdateMigrator marker bumps (`VAULT_AUTH_RESOLVE`);
customized copies are skipped, never overwritten.

## What to Tell Your User

If you start a long unattended work session and its setup can't actually take
hold, I now tell you immediately with a plain reason — instead of you
discovering the next day that nothing ever ran.

## Summary of New Capabilities

- Autonomous setup + stop hook work on vault-migrated agents (token from the vault).
- A refused run registration is loud, and stops setup where arming is impossible.
- A silent shell-trap death in setup's concurrency fallback is fixed.
- Both fixes reach deployed agents via migration.

## Evidence

- Unit `tests/unit/autonomous-setup-vault-auth.test.ts` (4 passing): runs the REAL script against a real HTTP server — the vault value reaches the server when config holds the placeholder; config string wins; enforcing + 403 aborts loudly with no state file; enforcing + unreachable still starts `preparing` (contract preserved, also covers the pipefail fix).
- Unit `tests/unit/PostUpdateMigrator-vaultAuthResolve.test.ts` (5 passing): the genuine pre-change blobs (pinned by commit) are re-deployed idempotently; the pinned predecessor SHA matches the real PREPARATION_CARRIER-era hook; customized copies are skipped by name.
- All 12 existing stop-hook suites (142 tests) and the 6 other setup-consuming suites (40 tests) pass against the modified scripts.
