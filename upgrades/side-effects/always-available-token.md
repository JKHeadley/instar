# Side effects: the before-login Claude sign-in for Always available (spec §B.4)

## Change
- `src/core/alwaysAvailableToken.ts`:
  - `setAlwaysAvailableToken` checks the code's shape, then its email through the OAuth profile. A mismatch, or a code that can't be checked, is refused and changes nothing. It stores the code with `writeClaudeKeyToConfig`, as `set-claude-key` does. It records the earlier credential in `state/always-available-token.json` (0600; the code itself appears there only as a sha256), keeping the first earlier credential across repeated sets.
  - `clearAlwaysAvailableToken` puts that credential back only while the stored code is still this one.
  - `alwaysAvailableTokenStatus` reports whether the code is in use, without any network call.
- `src/core/CredentialIdentityOracle.ts`: the profile check is extracted as `emailForClaudeToken`, and the oracle calls it; its behaviour is unchanged.
- `src/commands/alwaysAvailable.ts` and `cli.ts` add `instar always-available token --email` (code on stdin, never argv), `token-clear` and `status` (FileVault from `fdesetup isactive`, plus the code status), for the Mac app's switch.

## Who is affected
Only an agent whose person turns on Always available from the Mac app. Without that, nothing runs.

## Rollback
Revert. A code already set stays as the agent's Claude sign-in, exactly as one set with `set-claude-key` would.

## Later changes from review
- `state/always-available-token` is key material (`KEY_MATERIAL_PATHS` and `KEY_MATERIAL_FILES`), so the file routes, backups, gitignore and the sync classifier treat it like the config's own credential.
- A key the person set by hand between two sets becomes the one restored.
- While the code is the key the server holds, `SessionManager.poolAccountForSpawn()` doesn't pin sessions to a pool account (spec: the code overrides the pool). It is gated on the held key, not the file, so sign-in and pool agree during the minute before the server re-reads the file.
- The server picks the code up without a restart through ClaudeKeyHealth's key watch (on by default).

## Review (independent, two rounds)
Round 1:
- high: the earlier credential sat outside the key-material list;
- medium: a hand-set key could be lost on a second set;
- medium: the pool still pinned sessions.

All are fixed. Round 2 concurred; its first small point (gate on the held key) is applied.

The two remaining small points: if the earlier credential was a secret-store placeholder, or a base URL is restored, the server keeps the code, or the old base URL, until a restart.
