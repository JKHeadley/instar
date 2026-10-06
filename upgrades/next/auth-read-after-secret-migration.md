# Agents can still call their own API after a second machine is paired

## What Changed

After `instar pair` externalizes secrets, `.instar/config.json` holds `{ "secret": true }` for `authToken`. Instar's hooks and scripts already read `$INSTAR_AUTH_TOKEN` first, but the CLAUDE.md "API Authentication" instruction still read the config directly and turned the placeholder into a rejected Bearer value (ACT-1303, reported by Luna/sagemind).

- `generateClaudeMd` (both auth sections): `$INSTAR_AUTH_TOKEN` → `node .instar/scripts/secret-get.mjs authToken` → config value only when it is a string.
- `PostUpdateMigrator.migrateClaudeMd` rewrites the old line in existing agents' CLAUDE.md (content-sniffed, idempotent).

## What to Tell Your User

If you've connected a second machine, I no longer get locked out of my own controls when I follow my setup notes. The notes now find my access key wherever it's kept.

## Summary of New Capabilities

None — a broken instruction is corrected for new and existing agents.

## Evidence

- `tests/unit/auth-read-after-secret-migration.test.ts`: the generated instruction resolves a plain string token, never emits the `{ secret: true }` placeholder (the old line does), and the migration rewrites an existing CLAUDE.md once.
- Live on this machine with no session env: a vault-externalized agent and a plain-config agent both get `200` from `/jobs` using the new lines; the old read gave `400`.
- 40 template/migration test files pass; the secret-externalization lint stays green.
