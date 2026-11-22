# Side effects: keychain writes send the secret on standard input, never on the command line (SEC-155)

In plain words: macOS `ps` shows every user's process arguments. `security add-generic-password ... -w <secret>` therefore exposed OAuth credential JSON and vault master keys to other local accounts while each write ran. That matters on a shared Mac, such as a Mac mini with more than one login. Every keychain write now goes to `security -i` on standard input, with the secret hex-encoded behind `-X`.

Tier 1 by size, security-sensitive: an independent second-pass review is attached below. Size: 1 new source file (`src/core/keychainStdinWrite.ts`) and 7 changed call sites. Six moved off the command line: `src/core/CredentialSwapExecutor.ts`, `src/core/OAuthRefresher.ts` ×2, `src/core/GlobalSecretStore.ts`, `src/core/SecretStore.ts`, `src/core/WorktreeKeyVault.ts` and `src/remediation/RemediationKeyVault.ts`. The seventh, `src/monitoring/CredentialProvider.ts`, already used stdin and now uses the shared writer. Also the credential-write lint rule (`scripts/lint-no-unfunneled-credential-write.js`), 1 new unit test file and 2 updated tests.

## What changes for running agents
- **`keychainAddInput`** builds `add-generic-password [-U] -a "<account>" -s "<service>" -X "<hex>"\n`. The account and service must be 1–256 characters with no double quote, backslash or control character. Anything else throws before any process starts. Real names are a macOS user name and fixed service strings such as `Claude Code-credentials`, so none is refused.
- **`keychainWriteSync`** runs `execFileSync('security', ['-i'], { input, stdio, timeout })`. Standard input is always a pipe. The caller's stdout and stderr choice is kept: the credential refresh still ignores both, the vaults still pipe them. The caller's timeout is kept. `GlobalSecretStore` passes its injected exec, so its tests still drive a fake keychain.
- **`keychainWriteAsync`** runs `execFile('security', ['-i'], { timeout })` and ends standard input with the line. It resolves or rejects on exit, with the same timeout. A broken-pipe error on standard input is swallowed because the exit callback reports the failure.
- **Line-length guard (found by measurement).** `security -i` reads at most 4096 bytes per line, newline included. A longer line is not refused. It is split: the first part runs as its own add command and stores a truncated item, over the real one when `-U` is set, and only the rest fails as an unknown command. This was measured on this Mac on 2026-11-22: a 4096-byte line works, a 4108-byte line stored a wrong item and exited 1. `keychainAddInput` therefore throws `secret too long` above 4096 bytes, before any process starts. That allows a secret of about 2,000 bytes. The largest real Claude credential item on this Mac is 1,076 bytes (a line of about 2,240). Vault keys are 44-byte base64. Above the limit a write now fails closed, the same as any failed keychain write: the refresh returns false and asks for sign-in again, the swap executor rejects, and the provider throws. Before, a secret on the command line had no such limit. The alternative for an oversized secret, putting it back on the command line, would undo this fix.
- **`CredentialProvider.writeCredentials`** already wrote through `security -i`, with its own unguarded line, so a credential over about 2,000 bytes would have stored a truncated item there. It now uses `keychainWriteSync` with the same `-U`, stdio and timeout, and gets the guard.
- **Lint.** `lint-no-unfunneled-credential-write` matched only the literal `add-generic-password`, which a call to the new helper never contains. It now also matches `keychainWriteSync(` and `keychainWriteAsync(` in a file that names the guarded `Claude Code-credentials` service, so the funnel rule still covers writes through the helper. Only the allowlisted files do that today.
- **Names** also refuse `$` and backtick, because the `-i` tokenizer is undocumented.
- **Same stored bytes.** `-X` stores the hex-decoded bytes, which are exactly what `-w` stored, so `find-generic-password -w` returns the same text to every reader.
- **Same failure behavior.** `security -i` exits with the failing command's status. A live check gave 45 for a duplicate and 2 for bad arguments. So a failed write still throws or rejects. The refresh still returns false and falls to needs-reauth, the secret stores still fall back to the key file, and the vaults still throw to their callers.
- **Same update rules.** Sites that used `-U` (the refresh and the swap executor) still update in place. Sites that delete and then add (the vaults and the secret stores) are unchanged.

## Not in this change
- Reads (`find-generic-password ... -w`) put no secret in the arguments. The secret comes back on standard output, so they are unchanged.
- Linux paths (`secret-tool`) are unchanged.
- `playbook-scripts/playbook-hmac.py` (line 95) still passes a key as `-w` on the command line. That file is outside `src`, and it is reported to the Chief of Staff for its own ledger row.

## Signal vs authority
Not applicable: this changes how a secret reaches the keychain, not who may act.

## Second-pass review
**Reviewer:** independent Claude Sonnet subagents (fresh context, read-only, given the finding, the diff and this note), 2026-11-22. Two rounds, both CONCUR.
- **Round one: CONCUR.** No argument-array `add-generic-password` remains in `src`. Every per-site behavior holds: `-U` only where it was before, the same timeouts and fallbacks, standard input piped for every caller's stdio choice, and `GlobalSecretStore`'s injected exec still used. The async path cannot hang or leave an unhandled broken pipe. Its notes were all taken. It asked to tighten names against `$` and backtick: done. It asked to confirm a credential-sized payload works: that measurement found the 4096-byte line limit and the truncated-item hazard, now guarded. It noted the lint lost sight of writes through the helper: the rule now matches helper calls. It also noted that `playbook-scripts/playbook-hmac.py` still passes a key on the command line: reported, out of scope.
- **Round two (the guard, the provider move, the lint): CONCUR.** The guard is in the one place the line is built, so every caller hits it before a process starts, and its boundary matches the measurement. The provider move keeps parity and still throws through the slot-locked funnel, and that file stays allowlisted. The lint run is clean and both new lint cases hold. Failing closed above about 2,000 bytes is better than a truncated credential, with about 2x headroom over the largest real item. Non-blocking: an aliased helper call would evade the lint, the same class of gap the lint already has.

## Rollback
Revert the commit. Stored items are unchanged, so nothing needs migrating either way.

## Tests
- `tests/unit/sec155-keychain-stdin.test.ts` (new, 8 cases): input shape and hex round trip, `-U` only when updating, unsafe names refused, arguments exactly `['-i']` with stdin piped, a failed write throws, the async path rejects an unsafe name before starting a process, and a source scan finds no argument-array `add-generic-password` left in `src`.
- `tests/unit/global-secret-store.test.ts`: the fake keychain accepts only the stdin form and throws on an argument-carried secret.
- `tests/unit/lint-no-unfunneled-credential-write.test.ts`: the helper aimed at the guarded service is flagged. The helper for a different vault is not.
- The new file also has a line-limit case: a line at the limit is accepted, one byte more is refused, and a realistic credential fits.
- Run here: those two plus `lint-no-unfunneled-credential-write`, `credential-write-lint-evasions`, `claude-keychain-account-read`, `oauth-refresher`, `credential-swap-executor` and `RemediationKeyVault`. That is 8 files, all passing, in two batches. After the round-two changes, `sec155-keychain-stdin`, `global-secret-store`, `lint-no-unfunneled-credential-write`, `credential-provider`, `credential-write-routing`, `account-switcher-provider` and `credential-location-gate` pass again. Typecheck is clean.
- Live on this Mac with a throwaway item: `keychainWriteSync` wrote and read back byte for byte, a second add without update threw, and `keychainWriteAsync` with update round-tripped. A second live check: a 3,000-byte secret was refused and stored nothing, and a realistic 1,022-byte credential round-tripped. The items were then deleted.

## Class-Closure Declaration
- `unbounded-self-action`: closure n/a. The same single keychain write per call, with no retry, schedule or loop added.
