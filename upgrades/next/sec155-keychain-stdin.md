# Keychain writes no longer put secrets on the command line

<!-- bump: patch -->

## What Changed

SEC-155. On macOS, the agent wrote OAuth credentials and its vault master keys to the keychain with `security add-generic-password ... -w <secret>`. That puts the secret in the process arguments, and on macOS `ps` shows every user's process arguments, so another account on the same Mac could read it while the write ran. Every keychain write now goes through the new `src/core/keychainStdinWrite.ts`, which sends the command to `security -i` on standard input, with the secret hex-encoded behind `-X`. The stored bytes are the same, so every reader gets the same value back. `security -i` exits with the failing command's status, so a failed write still fails and each caller's fallback still runs.

The six writes that changed are the Claude credential refresh (sync and async), the credential swap executor, the secret store and global secret store master keys, the worktree key vault and the remediation key vault. The credential provider already wrote this way.

## What to Tell Your User

- **Safer keychain writes**: "When I save a login or a vault key to your Mac's keychain, the secret no longer appears in the list of running programs, where another account on the same Mac could have seen it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Keychain writes keep secrets off the command line | Automatic |

## Evidence

- `tests/unit/sec155-keychain-stdin.test.ts` (new). The input line carries the secret only as hex. The `-U` flag is added only when updating. Unsafe account or service names are refused. The process arguments are exactly `['-i']` and standard input is a pipe. A failed write still throws. A source scan finds no argument-array `add-generic-password` left in `src`.
- `tests/unit/global-secret-store.test.ts`: the fake keychain now accepts only the stdin form and refuses a secret passed as an argument.
- A live check on a Mac with a throwaway item: written and read back byte for byte, a duplicate without update failed as before, and an async update round-tripped.
