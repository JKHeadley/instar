# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Second increment of the approved agent-held Google passkeys spec
(`docs/specs/agent-held-google-passkey.md` §3.1). It adds `PasskeyCredentialStore`, a separate
encrypted store for the agent's own Google passkeys at `.instar/secrets/passkeys/store.enc`. The
store uses the same encryption and master key as the shared vault, but it is a different file, so
older versions of Instar, secret sync and the ordinary vault tools never see it. Every write takes a
lock and is checked by reading it back. A credential only loads on the machine that minted it, or
after the operator has adopted it on that machine. Nothing uses the store yet; later increments wire
it in.

This increment also closes two gaps that existed before it:
- A backup whose file list named something inside `secrets/` (for example `secrets/passkeys/` or
  the vault file itself) copied it into the snapshot. The block only matched a different spelling of
  the path.
- The tool that carries a conversation's working files between machines would have carried a file
  from the secrets folder if pointed at one.

Both now refuse the whole secrets folder, regardless of how the path is spelled or capitalised. New
and existing agents also get `secrets/` added to their git ignore lists.

## What to Tell Your User

Your agent's saved passwords and sign-in keys are now kept out of backups and never carried to your
other machines, even if something asks for them by name.

## Summary of New Capabilities

- A dedicated, locked, encrypted store for the agent's own sign-in keys (inactive until later
  updates).
- Backups and machine-to-machine file transfer refuse the secrets folder completely.
- Secrets can't be committed to git by accident.

## Evidence

- Before the fix, a probe backup with `includeFiles: ['secrets/passkeys/']` copied the passkey
  store, pending records and vault file into the snapshot; after the fix, none of the seven path
  spellings tested is copied (`tests/unit/passkey-secrets-exclusions.test.ts`).
- `tests/unit/passkey-credential-store.test.ts`: 16 tests. The two multi-process tests fail when the
  lock is removed and pass with it.
- The new working-set test fails without the fix; the related backup, migrator, file-viewer,
  working-set and secret-store suites all pass (140 files, 951 tests).
