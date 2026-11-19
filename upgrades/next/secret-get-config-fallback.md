# The secret reader also finds keys still kept in the plain settings file

<!-- bump: patch -->

## What Changed

`.instar/scripts/secret-get.mjs` now falls back to a plain string at the same name in `.instar/config.json` when the encrypted vault doesn't have the key, or when the machine has no vault. A `{ "secret": true }` placeholder is never returned, the vault wins when both have the key, and one stderr line names the source (never the value). Before this, a machine whose secrets were never moved into the vault returned nothing for `authToken`, so callers that hid stderr silently sent an empty token and were refused.

## What to Tell Your User

- **Fewer silent "unauthorised" errors on older machines**: "On a machine where my keys are still kept in the plain settings file, my own tools now find them instead of quietly failing."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| secret-get falls back to plain config.json values | Automatic |

## Evidence

Reproduced on the M5 on 2026-11-18: `secret-get.mjs authToken` printed 0 bytes while `.instar/config.json` held a 36-character plain `authToken`. Tests: `tests/unit/secret-get-plain-config-fallback.test.ts` (no vault, vault without the key, vault wins, placeholder never returned, no-plain-value error kept) and the existing `secret-get-legacy-passkey-read-log.test.ts`: 7 passed.
