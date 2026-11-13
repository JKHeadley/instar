---
title: "Agent removal must not silently retain credentials"
slug: "feedback-feedback-c88cd640-2a09-4319-b534-377be94dad5c"
author: "echo"
initiative: "feedback-c88cd640-2a09-4319-b534-377be94dad5c"
cluster: "cluster-nuke-here-writes-an-unasked-secrets-backup-with-its-key-besi"
severity: "critical"
related-specs:
  - "specs/dev-infrastructure/nuke-here.md"
  - "docs/specs/keychain-per-agent-master-key.md"
---

# Agent removal must not silently retain credentials

## Problem statement

`instar nuke --here` and `instar nuke <name>` always copy the removed
agent's credentials into the machine-wide encrypted store at
`~/.instar/secrets/`. They do this even when the user never set up a secret
backend, and even when that store did not exist before. Removal is supposed to
remove the agent's data. Instead it creates a new, long-lived copy of the
agent's most sensitive values: the Telegram bot token, the Telegram chat id, the
server auth token, the dashboard PIN and the tunnel token. Users cannot opt out,
and under `--yes` they are never asked.

This spec defines a credential-retention policy for agent removal and the code
changes that enforce it.

## Evidence

### Report (untrusted reporter text, summarised)

One report, received 2026-11-05, on instar 1.3.1677. The reporter ran
`instar nuke --here --yes` on a throwaway install. Afterwards
`~/.instar/secrets/global.key` and `~/.instar/secrets/global.secrets.enc`
existed. The reporter says these files held the removed agent's Telegram bot
token, chat id, auth token and dashboard PIN. The reporter expected no backup
for a throwaway, or an explicit opt-in. They also flagged that the key file sits
next to the encrypted data.

### Code trace (current HEAD)

1. **Backup is unconditional.** `src/commands/nuke.ts`:
   - `nukeHere` step 3 (around line 368) builds
     `new SecretManager({ agentName: projectName })` and calls
     `backupFromConfig({...})` whenever the config has a Telegram messaging
     entry. No flag or prompt gates this call.
   - `nukeAgent` step 4 (around line 185) does the same for standalone agents.
     Its plan output does not mention secrets at all. The user learns about the
     backup only from the after-the-fact line
     "Secrets backed up (will auto-restore on reinstall)".
   - `nukeHere` lists "Secrets backed up (auto-restored on next setup)" in its
     plan. That line is only information: no choice is offered, and with
     `--yes` nobody sees a prompt.
   - `src/cli.ts` (the `nuke [name]` command) has no option to control this.

2. **"No backend configured" still writes to the global store.**
   `SecretManager.set()` (`src/core/SecretManager.ts`, around line 167) writes
   to the local `GlobalSecretStore` in every backend mode, including
   `'manual'`. The comment says "Save to local even in manual mode — improves
   future experience". `'manual'` is the default when
   `~/.instar/secrets/backend.json` is absent. So a user who never chose a
   secret backend still gets one during removal.

3. **The store is created on first write.** `GlobalSecretStore`
   (`src/core/GlobalSecretStore.ts`):
   - The constructor runs `mkdirSync(~/.instar/secrets, 0o700)`
     unconditionally.
   - `autoInit()` with no existing key file first tries `initWithKeychain()`.
     That works only on darwin, and only when `security add-generic-password`
     succeeds. If it fails, `autoInit()` falls back to
     `initWithMachinePassword()`.
   - Both paths write `global.key` and an empty `global.secrets.enc`. Then
     `setSecret` fills `global.secrets.enc` with the agent's values.

4. **What "key beside the data" means depends on the path taken:**
   - *Keychain path:* `global.key` contains only `{"type":"keychain"}`. The real
     master key lives in the macOS login keychain. The adjacent file is a marker,
     not key material.
   - *Machine-password path* (non-macOS, headless/SSH sessions, a locked or
     unavailable keychain, sandboxed runs): `global.key` holds the PBKDF2 salt
     and iteration count. The password is the fixed string
     `instar-local-${os.hostname()}-${os.homedir()}`. Anyone who can read the
     two files and knows or can guess the hostname and home directory can
     decrypt them. That includes any process running as the user, or a backup
     or sync tool that copies `~/.instar`. On this path the encryption is
     obfuscation, not protection.

   Both files are written with mode 0600 inside a 0700 directory. This matches
   the triage note: having the key file next to the data does not, by itself,
   show that another local user could read it. The real defects are that the
   copy is made without consent, that it outlives the removal, and that on the
   fallback path it is only weakly protected.

5. **Retained secrets are keyed only by agent name.** Restore happens in the
   setup wizard ("Try restoring secrets" calls
   `SecretManager.restoreTelegramConfig()`), using the new agent's name. Any
   later install that uses the same name (`projectName` defaults to the
   directory basename) will be offered the old throwaway's bot token and chat
   id. A different project can therefore pick up credentials it was never
   given.

6. **No removal path cleans up.** `GlobalSecretStore.deleteAgent()` exists,
   but neither nuke path calls it and no CLI command exposes it. Once retained,
   credentials stay until the user deletes files by hand.

### Reproduction (to be encoded as tests; not run in this sandbox)

1. Use a temporary `HOME` with no `~/.instar/secrets`.
2. Create a project-local install whose `.instar/config.json` has a Telegram
   messaging entry (token and chatId), `authToken` and `dashboardPin`.
3. Run `nukeHere({ dir, skipConfirm: true })`.
4. Observe: `$HOME/.instar/secrets/global.secrets.enc` and `global.key` now
   exist. A `GlobalSecretStore($HOME/.instar/secrets)` lookup for
   `projectName` returns the removed agent's values.

## Retention policy (proposed, normative)

**R1. Removal removes by default.** `instar nuke` (both forms) does not keep
the removed agent's credentials unless the user explicitly asks.

**R2. Opt-in only.** Credentials are kept only when:
- `--keep-secrets` is passed, or
- in interactive mode, the user answers yes to a separate prompt. The prompt
  defaults to **No** and is shown only when there are credentials to keep.

`--yes` skips confirmation prompts only. It never counts as consent to keep
credentials.

**R3. No side-effect stores.** A removal that does not keep credentials must
not create `~/.instar/secrets/`, `global.key`, `global.secrets.enc`, a keychain
entry or `backend.json`. Constructing `GlobalSecretStore` counts as a write,
because its constructor creates the directory.

**R4. Purge existing retained copies.** If the global store already exists and
already has an entry for the agent being removed, the default removal deletes
that entry with `deleteAgent(name)`. The removal plan lists this step
("Stored credentials for `<name>` in ~/.instar/secrets — will be deleted").
`--keep-secrets` skips the purge. Bitwarden entries are not touched in this
change. If the user's backend is Bitwarden, the plan says so: "Bitwarden
entries for `<name>` are not modified".

**R5. Honest disclosure.** The plan and the summary say exactly what was kept,
where, under which name, and how to delete it. They also say how it is
protected:
- "macOS Keychain-backed", or
- "machine-derived key — readable by any process running as you".

**R6. Weak-protection warning.** If keeping credentials would create or use a
`pbkdf2-auto` store:
- With `--keep-secrets`, removal prints a warning and proceeds, because the
  user explicitly opted in.
- In interactive mode, the prompt text includes the warning before asking.

## Proposed fix

### Code changes

1. **`src/cli.ts`**: add `--keep-secrets` to `nuke [name]` and pass it through
   as `keepSecrets` to both `nukeHere` and `nukeAgent`.

2. **`src/commands/nuke.ts`**: extract one shared helper,
   `retainOrPurgeAgentSecrets({ agentName, config, keepSecrets, interactive, secretsDir? })`,
   which returns a disclosure record. Both nuke paths use it.
   - Collect candidate values with the existing `asStr` guards, so the
     `{ secret: true }` placeholder is still rejected. If none are present, do
     nothing, keep nothing and create nothing.
   - **Plan phase** (before confirmation), using read-only checks
     (`fs.existsSync` on `global.secrets.enc`; no `GlobalSecretStore`
     construction when the store is absent):
     - Show "will be kept" if keeping, "will be deleted" if a retained entry
       exists, or nothing if neither applies.
     - When interactive and there are candidates, add the separate
       default-No keep prompt (R2).
   - **Execute phase:**
     - Keep: call `SecretManager.backupFromConfig` as today, then report how the
       store is protected (R5/R6) by reading the `type` field in `global.key`.
     - Don't keep, store exists: `new GlobalSecretStore()`, `autoInit()`, then
       `deleteAgent(agentName)`. Report a failure to unlock through
       `DegradationReporter` and the console; never fail silently.
     - Don't keep, store absent: no-op (R3).
   - Replace the fixed lines "Secrets backed up (auto-restored on next
     setup)" and "Secrets backed up (will auto-restore on reinstall)" with
     disclosure-driven text.
   - Add an optional `secretsDir` / `homeDir` parameter (default
     `~/.instar/secrets`) so tests can point the helper at a temp directory
     without depending on the real `HOME`.

3. **`src/core/SecretManager.ts`**: no behaviour change in this spec. The
   "manual mode still writes to local" default in `set()` is the root
   amplifier for other callers too. It is logged as a follow-up (see Open
   questions) rather than changed here, because setup and pairing flows depend
   on it.

4. **Docs**:
   - Update `specs/dev-infrastructure/nuke-here.md` (section "Secret backup",
     step 3) and the `nuke` command help text to state the R1–R6 policy.
   - Add an upgrade note: removal no longer keeps credentials for reinstall
     unless `--keep-secrets` is passed.

### Tests (to be written alongside the fix)

Each test uses a temporary `HOME` / `secretsDir` and a fake install directory.
Tests that need the keychain path inject `keychainExec`; all others use the
basePath, which means the `pbkdf2` / no-keychain behaviour.

- `tests/unit/nuke-secret-retention.test.ts`
  - `nuke --here --yes without --keep-secrets creates no global secret store`:
    fails on current code (both files appear) and passes after the fix.
  - `nuke --here --yes without --keep-secrets purges a pre-existing retained entry for the agent`.
  - `nuke --here --yes --keep-secrets retains credentials and discloses the protection type`.
  - `nuke --here with only {secret:true} placeholders retains nothing`.
  - `nukeAgent mirrors nukeHere retention semantics` (same three cases for the
    standalone path).
  - `purge leaves other agents' entries in the global store untouched`.
- `tests/unit/nuke-here.test.ts` (existing, if present): update the expected
  plan text.

### Migration and compatibility

- Users who relied on "nuke then reinstall restores Telegram automatically"
  now need `--keep-secrets`. The setup wizard's restore step does not change.
  It simply finds nothing to restore unless the user opted in.
- Existing `~/.instar/secrets` stores are never deleted wholesale. The fix only
  removes the entry for the agent being nuked (R4). Stores left by earlier
  versions for agents that no longer exist stay until the user removes them. The
  release note should tell affected users how to inspect and delete
  `~/.instar/secrets/`.
- Rollback: revert the commit. No data format changes.

## Out of scope / open questions

1. **`SecretManager.set()` in `'manual'` mode.** Should it keep writing to the
   local store? Today any `set()` creates the global store with no configured
   backend. A separate spec should decide whether `'manual'` means "no
   persistence".
2. **The `pbkdf2-auto` fallback itself.** Should it be replaced? Options are
   refusing to create a store when no keychain or user password is available, or
   adopting the per-agent keychain design in
   `docs/specs/keychain-per-agent-master-key.md`. This needs its own review.
3. **Name collisions on restore (Evidence §5).** Should retained entries be
   keyed by agent name plus install path or id, so that an unrelated project
   with the same basename is not offered another agent's credentials?
4. **A user-facing purge command.** An `instar secrets forget <name>` /
   `instar secrets list` command would let users clean up stores left by
   earlier versions.
5. **Bitwarden entries.** Should removal offer to delete Bitwarden entries
   too? They are left untouched here.
