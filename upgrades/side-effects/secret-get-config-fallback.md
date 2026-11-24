# Side-effects review: secret-get.mjs falls back to a plain config.json value

## Summary

`src/templates/scripts/secret-get.mjs` read only the encrypted vault. On a machine whose secrets were never migrated (the M5, Nov 17), `authToken` lives as a plain string in `.instar/config.json`, so the script exited 1 with nothing on stdout and callers using `$(... 2>/dev/null)` silently got an empty bearer token. The script now falls back to a plain, non-empty string at the same dot path in `.instar/config.json` when the vault lacks the key or no vault exists. A `{ "secret": true }` placeholder is never returned. Vault wins when both exist. Tier 1, 2 files of code (script + new test), about 50 LOC. Review effort: one pass, first commit attempt.

## 1. Over-block

None. The change only turns some former failures into successes; nothing that succeeded before fails now.

## 2. Under-block

An undecryptable vault (master-key mismatch) still exits 1 without trying config.json. That is deliberate: that error means "surface to the operator, do not route around it", and a plain-config value next to a broken vault is more likely stale. `--names` still lists vault keys only.

## 3. Level-of-abstraction fit

Right layer. The server already resolves secrets from config.json first and the vault second (`SecretStore` placeholders); the retrieval helper now matches what the server itself reads instead of each caller carrying a second fallback line.

## 4. Signal vs authority compliance

Not a decision point: no gate, filter or block. A read helper returning a value it previously failed to find. `docs/signal-vs-authority.md` does not apply.

## 5. Interactions

The documented two-line read in agent instructions (secret-get, then a python read of config.json) still works; its second line now rarely runs. The Google passkey read log is unchanged (passkeys live only in the vault). The containment contract holds: the value goes to stdout once, stderr names only the source.

## 6. External surfaces

Agents whose callers relied on the failure (an empty token) now get the real token from config.json. That is the intended outcome. No network, no new file writes.

## 7. Multi-machine posture

Machine-local by design: each machine's script reads that machine's own vault and config.json, the same files its own server reads. This change removes a difference between migrated and unmigrated machines rather than adding one.

## 8. Rollback cost

Revert the commit; the next update rewrites the script (always-overwrite in `PostUpdateMigrator`). No state.
