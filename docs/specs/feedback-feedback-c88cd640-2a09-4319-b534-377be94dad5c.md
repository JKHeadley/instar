---
title: Agent removal must not silently retain credentials in the global secret store
status: draft
created: 2026-11-14
initiative: feedback-c88cd640-2a09-4319-b534-377be94dad5c
component: Agent removal (`instar nuke <name>`, `instar nuke --here`) and GlobalSecretStore
severity: critical
---

# Agent removal must not silently retain credentials in the global secret store

## Problem

`instar nuke --here --yes` (and `instar nuke <name>`, which works the same way) copies
the removed agent's credentials (Telegram bot token, chat id, auth token, dashboard PIN,
tunnel token) into the machine-wide store at `~/.instar/secrets/`. It does this
**unconditionally and without asking**. When that store does not exist yet, removal
**creates** it: `global.key` and `global.secrets.enc`. A user who removes a
throwaway agent so that nothing is left over ends up with a new, long-lived credential
store they never asked for.

Removal has no written policy for credentials. The retention behaviour is only implied
by a "will auto-restore on reinstall" status line, and with `--yes` the user never sees
the plan before it runs.

## Evidence

Reporter (1 report, instar 1.3.1677, 2026-11-05): after `instar nuke --here --yes` on a
throwaway agent, `~/.instar/secrets/global.key` and `global.secrets.enc` had been
created and held the removed agent's Telegram token, chat id, auth token and dashboard PIN.
The reporter expected no backup for a throwaway, or an explicit opt-in.

Code trace (current HEAD):

- `src/commands/nuke.ts` step 4 (`nukeAgent`) and step 3 (`nukeHere`) call
  `new SecretManager({ agentName }).initialize()` and then `backupFromConfig(...)`
  whenever the config has a Telegram messaging entry. The only gate is
  `options.skipConfirm` on the overall prompt. Nothing asks about retention
  specifically, and `--yes` skips even the plan's
  "Secrets backed up (auto-restored on next setup)" line.
- `SecretManager.set()` writes to the local store **even when the backend is `manual`**,
  which is what you get when there is no `backend.json` ("Save to local even in manual
  mode"). So a machine with no configured secret backend still gets a global store.
- `SecretManager.setToLocal()` → `GlobalSecretStore.autoInit()`. If there is no key file,
  `autoInit()` tries `initWithKeychain()`. On macOS that generates a key, stores it in
  the Keychain and writes `global.key = {"type":"keychain"}`. If that fails, or on any
  other platform, it calls `initWithMachinePassword()`, which writes
  `global.key = {"type":"pbkdf2-auto", salt, iterations}`. Either way it then writes an
  empty `global.secrets.enc`, then the secrets. That is how removal ends up creating the store.
- `specs/dev-infrastructure/nuke-here.md` §3 documents the backup as intended
  ("so that a subsequent `npx instar setup` … auto-restores"). The behaviour was designed
  that way. The gaps are consent and a retention policy.

### What the adjacent `global.key` does and does not mean

Having the key file next to the data does not by itself mean anyone can read the data. That depends on which kind of key file it is:

| `global.key` type | What the file contains | Who can decrypt `global.secrets.enc` |
|---|---|---|
| `keychain` | A marker only (`{"type":"keychain"}`), no key material | Only code that can read the login Keychain item `instar-global-secrets`/`master-key` (Keychain access control applies) |
| `pbkdf2-auto` | Salt + iteration count | **Anyone who can read the file as this user**, because the password is `instar-local-<hostname>-<homedir>`, which can be derived from the machine itself. This is obfuscation, not real protection against other local processes or a copied home directory. |
| `pbkdf2` | Salt + iteration count | Only someone who knows the user-chosen password |

The report does not say which type the reporter got. On macOS with a working Keychain it
would be `keychain`. Either way, the user did not agree to the credentials being kept, and
under `pbkdf2-auto` the copy is effectively readable by any process running as that user.
The fix must therefore address consent, and it must tell the user what protection a kept copy actually has.

### Related hazard found while tracing

Global entries are stored by **agent name only** (`agents[<name>]`). For `nuke --here` the name is
`config.projectName || basename(dir)`. `AgentRegistry.ts` states agent names are
"display labels only — NOT unique". So two installs with the same name share one entry
in the store. Any purge added by this fix must not delete a different, still-installed
agent's credentials.

## Credential-retention policy (proposed, normative)

- **R1. Default is no retention.** Removing an agent keeps no copy of its credentials.
  This holds for both `nuke <name>` and `nuke --here`, with or without `--yes`.
- **R2. Retention is explicit opt-in.** You keep credentials only by passing `--keep-secrets`,
  or by answering yes to a separate retention question in the interactive prompt (default **No**).
  `--yes` alone never means "keep".
- **R3. Removal never creates a credential store unless the user opted in (R2).** If the user did not opt in,
  removal must not create `~/.instar/secrets/`, `global.key`, `global.secrets.enc` or a
  Keychain item, and must not rewrite them.
- **R4. Without retention, earlier copies of *this* agent's credentials are purged**
  from an existing global store, if the store can be unlocked without side effects. If it
  can't be unlocked, the user is told which entries are left and how to remove them.
- **R5. Purge only touches the agent being removed.** Purge is skipped, with a warning, when
  another registered agent has the same name.
- **R6. The user is told how a kept copy will be protected *before* agreeing**, and the
  command refuses to fall back silently to weaker protection than it announced.
- **R7. The plan output shows exactly what will happen to credentials:** "not retained /
  existing copy purged", "not retained / existing copy could not be purged", or
  "retained in `<path>` protected by `<keychain|machine-derived|password>`".

## Proposed fix

### 1. Side-effect-free store probing and unlocking (`GlobalSecretStore`)

Add methods that **never** create, initialize or overwrite anything:

- `GlobalSecretStore.probe(basePath?)` (static). It must not call the constructor's
  `mkdirSync`, so it must not create `~/.instar/secrets/`. It returns
  `{ dirExists, encExists, keyType: 'keychain' | 'pbkdf2-auto' | 'pbkdf2' | 'missing' | 'unreadable', newStoreProtection: 'keychain' | 'machine-derived' }`.
  `newStoreProtection` is a prediction, with no writes: `keychain` only when
  `process.platform === 'darwin'` and the keychain path is enabled, otherwise `machine-derived`.
- `unlockExisting(): 'unlocked' | 'no-store' | 'locked' | 'key-missing' | 'password-required'`.
  It reads only. Rules:
  - `encExists === false` → `no-store`. It does **not** generate a key.
  - `encExists && keyType === 'missing'` → `key-missing`. It does **not** call `autoInit()`, it
    does **not** write a key file, Keychain item or an empty store. This closes the case
    where the earlier attempt's `autoInit()` could replace the store with an empty one.
  - `keychain` → `readKeychain()` only. If the item is missing → `locked`. No generation.
  - `pbkdf2-auto` → derive the key and verify with a decrypt. If that fails → `locked`.
  - `pbkdf2` → `password-required`. Removal never prompts for the store password.
- `initNewStore(protection: 'keychain' | 'machine-derived')`. It creates a store with
  **exactly** the protection given. If `keychain` was requested and `writeKeychain` fails,
  it throws. It does **not** fall back to machine-derived.

`autoInit()` stays as it is for its existing callers. The new removal path must not call it.

### 2. Removal flow (`src/commands/nuke.ts`, both `nukeAgent` and `nukeHere`)

Pull the secret step out into one shared helper, `planCredentialDisposition()` →
`applyCredentialDisposition()`, used by both commands.

**Before the confirmation prompt** (planning only, no writes):

1. `probe()` the global store.
2. Work out `retain` from `--keep-secrets`, or from the interactive retention question
   (default No; it is not asked under `--yes`, so `--yes` alone → `retain = false`).
3. If `retain`:
   - If the store exists (`encExists`), protection is the existing `keyType`. Show it.
     If `unlockExisting()` would not return `unlocked` (checked read-only at planning time),
     retention is not possible. Say so in the plan and switch to `retain = false` with a warning.
     Never re-initialize the store.
   - If there is no store, protection is `newStoreProtection`. If that is
     `machine-derived`, the plan shows a warning **before consent**: "the copy would be
     encrypted with a key derived from this machine's hostname and home path; any
     process running as you can read it". Interactively the retention question repeats this
     warning. Under `--yes --keep-secrets`, creating a machine-derived store also needs
     `--allow-weak-secret-protection`. Without it, retention is skipped and the reason is printed.
4. If not `retain`: work out purge eligibility **regardless of what the config contains**.
   Purge eligibility does not depend on whether the config has real values, `{secret:true}`
   placeholders or no Telegram entry at all (this was finding 1 of the earlier review). It is:
   `encExists` && no other registry entry has the same name (R5) && the agent has an entry
   in the store (checked read-only after `unlockExisting()`).
5. Print the credential line of the plan (R7). Under `--yes` the plan is still printed,
   because only the prompt is skipped.

**After confirmation:**

- `retain` + existing store → `unlockExisting()` must return `unlocked`, then
  `setAgentSecrets(name, values)` with only real string values (keep the existing
  `asStr` guard so `{secret:true}` placeholders are never stored).
- `retain` + no store → `initNewStore(plannedProtection)`. If the actual protection would
  differ from what was announced (for example the Keychain write fails), throw. Nothing is
  written, and the user is told that nothing was retained. Consent was given for one kind of
  protection, so the command never quietly uses another (this was finding 3 of the earlier review).
- not `retain` + eligible → `deleteAgent(name)` on the unlocked store. This must rewrite
  only the existing file under the existing key, never under a new key.
- not `retain` + store exists but is `locked` / `key-missing` / `password-required` → touch
  nothing. Print: "a previous copy of `<name>`'s credentials may remain in
  `~/.instar/secrets/global.secrets.enc`; it could not be unlocked, so it was left as is."
- not `retain` + no store → do nothing, and **create nothing** (R3).

`SecretManager.backupFromConfig` is no longer called from nuke. Do not change the
`manual`-mode "save to local anyway" behaviour of `SecretManager.set` in this change, because other
callers depend on it. The removal path just stops going through it.

### 3. CLI and docs

- `src/cli.ts`: add `--keep-secrets` and `--allow-weak-secret-protection` to `nuke`.
- Update `specs/dev-infrastructure/nuke-here.md` §3 and the header comments in `nuke.ts`
  so they state policy R1–R7 instead of "secrets backed up (auto-restored)".
- Release note: removal no longer keeps credentials by default. Users who relied on
  auto-restore after `nuke` must pass `--keep-secrets`.

## Tests to add (fail on HEAD, pass after the fix)

All tests use a temp `basePath` and an injected `keychainExec`. None touch the real `~/.instar` or Keychain.

1. `tests/unit/nuke-credential-retention.test.ts`
   - **"nuke --here --yes on a machine with no global store creates no secrets files"**:
     assert that `secrets/` dir, `global.key` and `global.secrets.enc` do not exist afterwards,
     and that no Keychain write was attempted. (This reproduces the report.)
   - Same check for `nuke <name> --yes`.
   - `--yes` with an existing store that holds this agent's entries → entries purged, and other
     agents' entries are byte-for-byte unchanged after decryption.
   - **Placeholder config**: Telegram config `{token:{secret:true}}`, or no Telegram entry
     at all, and the store has an entry for the agent → it is still purged (finding 1).
   - **Same-name agent still registered** → no purge, warning printed, store unchanged.
   - `--keep-secrets --yes` with an existing keychain store → entries written, and the plan
     shows `keychain`.
   - `--keep-secrets --yes`, no store, non-darwin (machine-derived predicted), without
     `--allow-weak-secret-protection` → nothing created, reason printed.
   - `--keep-secrets --yes`, no store, darwin predicted, Keychain write fails → nothing
     created (no machine-derived fallback), user told nothing was retained (finding 3).
   - The plan output contains the credential line before the prompt is shown (an interactive
     path with a mocked `@inquirer/prompts` records the order).
2. `tests/unit/global-secret-store.test.ts` (extend)
   - **"unlockExisting on an encrypted store with a missing key file returns key-missing and writes nothing"**:
     snapshot the dir (names, sizes, mtimes, file bytes) before and after. No `global.key`
     is created, `global.secrets.enc` keeps its bytes, and there are no Keychain write calls (finding 2).
   - `unlockExisting` with a keychain marker whose item is missing → `locked`, nothing written.
   - `probe()` on a non-existent dir does not create it.
   - `initNewStore('keychain')` with a failing Keychain write throws and leaves no files.

## Out of scope / open questions

- Bitwarden backend: earlier `nuke` runs also wrote to Bitwarden when that backend was active.
  Should purge reach Bitwarden? Proposal: for now, print a note telling the user the remote
  vault may hold copies, and do not delete remote items automatically.
- Upgrading `pbkdf2-auto` stores to Keychain or a user password, and how weak
  machine-derived protection is for other callers of `autoInit()`, is a separate hardening item.
- Credentials already kept by earlier versions on machines that never run `nuke` again
  are left alone. A one-off `instar secrets forget <name>` command could be proposed separately.
