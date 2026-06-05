<!-- bump: patch -->

## What Changed

A submitted Secret Drop is now persisted store-first to the durable
AES-256-GCM encrypted SecretStore the instant it is received, instead of
living only in the server's in-memory `received` map. The retrieve route
transparently falls back to the durable copy when the in-memory one is gone
(server restart, compaction, cross-machine handoff), and a successful consume
deletes both copies — one-time semantics are preserved. Opt out with
`secrets.persistDrops: false` in `.instar/config.json`.

This closes the recurring "the user dropped a secret and the agent lost it"
failure: with the fleet shipping many releases a day, every release restarted
the server and evaporated any un-consumed submission.

Also: the SecretStore master-key manager now forces file-key mode during test
runs (`VITEST` / `NODE_ENV=test`). The OS keychain entry is machine-global —
a test constructing a SecretStore against a fresh stateDir used to generate a
new master key and silently overwrite that shared entry, making every real
agent vault on the machine undecryptable for keychain-resolving readers. No
test can touch the real keychain anymore. A `secrets.forceFileKey` config
plumb is also available for operators who want to pin the key source.

The CLAUDE.md template's Secret Drop "Security" bullet is rewritten (the old
"in-memory only, never written to disk" claim is no longer true), and an
idempotent migration updates existing agents' CLAUDE.md in place.

## What to Tell Your User

If you hand me a secret through a drop link, it now survives my server
restarting, updating, or the conversation moving between machines. You should
never have to re-send a secret because "I lost it" again. Secrets are stored
encrypted and are deleted as soon as they're consumed.

## Summary of New Capabilities

- Secret Drop submissions persist store-first to the encrypted SecretStore and survive server churn.
- Retrieval transparently falls back to the durable copy; consume deletes both copies.
- `secrets.persistDrops: false` opts out (default ON).
- Tests can never pollute the machine-global SecretStore keychain entry (structural guard).
- `secrets.forceFileKey` pins the master-key source to the per-agent file key.

## Evidence

`tests/integration/secret-drop-store-first.test.ts` (5 route-level tests, both
sides of every boundary), `tests/unit/secret-store.test.ts` (keychain
pollution guard), `tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts`
(+3 migration tests), and the Tier-3 e2e
`tests/e2e/secret-drop-store-first-lifecycle.test.ts` — which boots two REAL
AgentServers on one stateDir and proves a secret submitted to process 1 is
retrievable from process 2 after a true restart. tsc + lint clean.
