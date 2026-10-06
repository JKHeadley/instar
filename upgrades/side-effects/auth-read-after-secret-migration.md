# Side-Effects Review — the CLAUDE.md API-auth instruction survives secret externalization

**Version / slug:** `auth-read-after-secret-migration`
**Date:** `2026-10-05`
**Author:** `echo`
**Second-pass reviewer:** `not required (instruction text + idempotent CLAUDE.md migration)`

## Summary of the change

ACT-1303 (reported by Luna/sagemind on Threadline, 2026-10-03): "instar pair moving secrets to {secret:true} breaks scripts that read them." After `SecretMigrator` externalizes `authToken`, `.instar/config.json` holds `{ "secret": true }`. Instar's shipped hooks and scripts were already migrated to read `$INSTAR_AUTH_TOKEN` first with a string-type guard, but the CLAUDE.md template's "API Authentication" section still told every agent to run `AUTH=$(python3 -c "...get('authToken',''))")`, which prints the placeholder object. Every curl an agent built from it was rejected (reproduced in this session: `400` with the config read, `200` with the env token).

The template (both occurrences in `generateClaudeMd`) now reads `$INSTAR_AUTH_TOKEN`, then `node .instar/scripts/secret-get.mjs authToken`, then the config only when the value is a string. `PostUpdateMigrator.migrateClaudeMd` rewrites the old line in existing agents' CLAUDE.md (content-sniffed, idempotent).

## Decision-point inventory

None. Instruction text and a text migration.

## 1. Over-block

Nothing is refused.

## 2. Under-block

Agent-authored custom scripts that copied the old one-liner are not rewritten (custom files are never touched); the corrected CLAUDE.md instruction is what agents copy from going forward.

## 3. Level-of-abstraction fit

CLAUDE.md is where agents learn this; the migration path is the documented one for CLAUDE.md sections.

## 4. Signal vs authority compliance

No authority involved.

## 4b. Judgment-point check

Not a decision point.

## 5. Interactions

Matches the env-first, string-guarded pattern Instar's hooks already use. The secret-externalization lint over `PostUpdateMigrator.ts` stays green: the old line is assembled from pieces because it is the text being removed.

## 6. External surfaces

CLAUDE.md text for new and updated agents. Verified live: on a vault-externalized agent and on a plain-config agent, with no session env, the new lines produce a token the server accepts (`200`).

## 7. Multi-machine posture (Cross-Machine Coherence)

Each machine's CLAUDE.md is migrated on its own update; the instruction resolves per machine (session env / local secret store / local config).

## 8. Rollback cost

Revert; the migration only rewrites one known line.

## Conclusion

Closes the last place Instar itself told agents to read a secret that pairing had moved.
