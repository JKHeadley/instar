---
title: "Secret vault sealed under an unresolvable master key: provenance, preservation and operator recovery"
slug: feedback-feedback-8071538f-b84d-43a9-99f9-f416cda8f0f5
status: draft
component: SecretStore / MasterKeyManager / Config.secretMerge
severity: critical
initiative: feedback-8071538f-b84d-43a9-99f9-f416cda8f0f5
cluster: cluster-secret-vault-undecryptable-after-2026-10-05-restart-store-ke
related-specs:
  - docs/specs/vault-key-coherence.md
  - docs/specs/keychain-per-agent-master-key.md
  - docs/specs/secret-key-diagnostic-policy.eli16.md
---

# Secret vault sealed under an unresolvable master key

## 1. Problem

After a server restart on v1.3.1319 (2026-10-05), the agent's shared secret vault
(`.instar/secrets/config.secrets.enc`, v2 format) could not be decrypted. The v2
header names key id `edbfcacac21fdc5c`; the only keys `MasterKeyManager` can
resolve are `keychain:f292f9871f09c0ff` and `file:e7b0b12b5aaa19c9`. As a result:

- `Config.secretMerge` degrades and config loads with unresolved `{secret:true}`
  placeholders (only the critical-placeholder boot guard stops a crash).
- Every session spawn logs `[ghToken] vault read failed` and starts without `GH_TOKEN`.
- `secret-get.mjs` refuses to read.

The vault bytes are intact (the existing error says so correctly). What is
missing is the key. Nobody can currently answer three questions:

1. **Which key source sealed the vault, and when?** The header has a key id, but
   not the source (per-agent keychain account, legacy global account, file),
   the stateDir spelling, the writer, or the build version.
2. **Where did that key go?** Neither on-disk file changed (vault mtime
   2026-09-16 10:30, file key mtime 2026-08-19 11:31), so the keychain side
   most likely changed between the seal and the restart.
3. **What can an operator do about it, safely?** There is no supported recovery
   path. The only options today are hand-editing the keychain or deleting the
   vault, and both risk making a recoverable loss permanent.

Permanent loss is **not** established. The right key may still exist under a
keychain account or path spelling the resolver doesn't check.

## 2. Evidence

From the scrubbed report (one report, 2026-10-05T17:05Z, server uptime ~2 min):

| Fact | Value |
|---|---|
| Version | v1.3.1319 |
| Vault header key id | `edbfcacac21fdc5c` |
| Resolvable candidates | `keychain:f292f9871f09c0ff`, `file:e7b0b12b5aaa19c9` |
| Vault mtime | 2026-09-16 10:30 (unchanged since) |
| File key mtime | 2026-08-19 11:31 (unchanged since) |
| Degradation rows | `fb-0b3e5937-601`, `fb-e4eb13db-cb3` |
| Operator action | none; vault deliberately not repaired or rotated |

Only one `keychain:` candidate is listed. Either the per-agent account
(`master-key:<path.resolve(stateDir)>`) and the legacy global account
(`master-key`) hold the same key, or one of them is absent.

## 3. Analysis (code as of this draft)

All references are to `src/core/SecretStore.ts`.

### 3.1 Ways the keychain key can change without the files changing

**H1. A failed keychain read is treated as "entry absent", and adoption then overwrites the per-agent entry. (Most likely.)**
`tryRead()` swallows every error and returns `null`. In the macOS backend,
`readOsKeychain()` returns `null` for these cases, which all look the same:
item not found, `security` timing out after 5 s, keychain locked, and "user
interaction is not allowed" (common in launchd or sandboxed contexts).
`getMasterKey()` then falls through to the legacy global slot. If that slot
holds a key, it **adopts** it: `kc.write(KEYCHAIN_SERVICE, perAgentAccount, legacy)`.
`writeOsKeychain()` runs `delete-generic-password` first, then
`add-generic-password`, so an existing per-agent entry is destroyed and replaced.
One transient read failure is enough to replace a working per-agent key (for
example `edbf…`) with whatever the shared legacy slot holds at that moment
(for example `f292…`). The legacy slot is shared by every agent on the machine,
and pre-#810 builds still write it. This matches the evidence: no file changed,
the keychain key differs from the seal key, and only one keychain candidate exists.

**H2. Generate-on-miss writes the per-agent entry.**
When the file key is absent, `getFileKey()` generates a key and writes it to the
per-agent keychain account (delete then add). On this host the file key exists
(mtime 08-19), so this path should not have run for this stateDir spelling.
It is listed because it shares H1's root cause: a destructive write triggered
by a lookup that may have been a failed read, not a real miss.

**H3. The vault was sealed under a different stateDir spelling.**
`perAgentKeychainAccount()` uses `path.resolve`, not `realpath`. A writer that
reached the same directory through a symlink, `/tmp` vs `/private/tmp`, or a
differently rooted path resolves a different keychain account. `getCandidateKeys()`
only checks the current spelling, so a key sealed under another spelling can
still exist in the keychain without the resolver ever seeing it.

**H4. External keychain change** (keychain reset, login-keychain replacement,
manual edit). Less likely, but the diagnosis in §4.2 must be able to tell this
apart from H1–H3.

### 3.2 Existing safety properties to keep

- `set()` and `delete()` call `read()` first, so they already refuse to
  overwrite an undecryptable vault.
- `read()` throws a precise wrong-key error and never returns `{}` for a vault
  that exists.

### 3.3 Gaps that can turn a recoverable loss into a permanent one

- `write()` does not check what it replaces. It seals with `getMasterKey()` and
  renames over whatever is on disk. Direct callers exist:
  `SecretMigrator.migrateSecrets` (after its own `read()`), and
  `PasskeyCredentialStore` `ensureInitialized`/`mutate` (for the separate passkey
  store, same envelope and master key). A future direct caller, or a caller
  whose `read()` result was cached from before the key changed, can orphan the
  ciphertext.
- Convergence-on-write re-seals a vault read with a non-primary key and does not
  keep the previous ciphertext. If the "primary" was itself the wrong key, the
  original can't be recovered.
- No record exists of which key source sealed the vault.

## 4. Proposed fix

The design is **additive and read-mostly**. It does not change the per-agent
account spelling, the v2 format, or which key `getMasterKey()` resolves on a
healthy machine (see §6 for why).

### 4.1 Stop destructive keychain writes triggered by failed reads (fixes H1/H2)

1. **Three-state keychain read.** `KeychainOps.read` returns
   `{ state: 'found', key } | { state: 'absent' } | { state: 'error', reason }`.
   On macOS, `absent` means `security` exited with the item-not-found status
   (44). Timeouts, locked keychain and interaction-not-allowed map to `error`.
   Linux `secret-tool` has the equivalent split: exit 1 with empty output means
   absent, anything else is an error.
2. **Writes only after a confirmed absence.** Adoption and generate-on-miss run
   only when the per-agent read returned `absent`. If it returned `error`,
   `getMasterKey()` uses the existing file key if there is one. Otherwise it
   throws `KeychainUnavailableError` and does not generate. It also emits one
   `SecretStore.keychainReadError` degradation report per process.
3. **Create-only keychain writes.** Adoption and generation use
   `add-generic-password` **without** a preceding delete and without `-U`, so
   they fail if the entry already exists. No automatic code path deletes or
   replaces an existing per-agent entry. The only path that replaces one is the
   operator recovery command in §4.4, and it keeps a copy of the old key (§4.4.3).

### 4.2 Key provenance

1. **Seal ledger.** Every successful `write()` appends one JSON line to
   `<storeFile>.provenance.jsonl`, next to the store and bounded to the last 200
   entries. Each line holds: `keyId` (hex, already public in the header),
   `source` (`keychain-per-agent` | `keychain-legacy` | `file`), the account name
   or file path used, `stateDirResolved`, `stateDirReal` (`realpath`), instar
   version, pid, a caller label passed by the writer, and an ISO timestamp.
   It never contains key bytes or secret values. This answers the reporter's ask:
   "which key id was the vault last sealed with, and when."
2. **Read-only key discovery** (`MasterKeyManager.discoverCandidates()`). This
   method never writes or generates. It covers everything `getCandidateKeys()`
   checks, plus:
   - per-agent accounts for alternate spellings of the stateDir: the `realpath`
     form, and the `/private` toggle on macOS (H3);
   - every account recorded in the provenance ledger;
   - preserved key copies from §4.4.3.

   Each probe reports `{ source, account|path, state, keyId? }`. Discovered keys
   are used **only** for diagnosis and operator recovery. They are never added
   to the automatic read path, and nothing is written under a discovered account.
3. **`instar secrets diagnose`** (CLI, read-only). It prints:
   - the vault header key id, size and mtime;
   - the last ledger entry;
   - every discovered candidate with its state and key id;
   - the passkey store's header key id, which corroborates the seal key when
     both stores were last written under it;
   - a verdict:
     - `OK`;
     - `KEY_MISMATCH_RECOVERABLE` (a discovered key matches the header and
       authenticates);
     - `KEY_MISMATCH_UNRESOLVED` (no discovered key matches);
     - `CORRUPT` (the key id matches but GCM authentication fails);
     - `KEYCHAIN_UNAVAILABLE`.

   It never prints key bytes. It exits non-zero for any verdict other than `OK`.

### 4.3 Preservation: authenticated-decrypt guard on every replacement

Addresses the previous review: a key-id match alone is **not** enough.

1. Before `write()` renames over an existing store file, it reads the current
   bytes and requires **successful AES-256-GCM authenticated decryption** under
   a currently resolvable candidate key. The key id is used only to pick the
   candidate. The tag must verify and the plaintext must parse as JSON. For v1
   (headerless) files, at least one candidate must decrypt.
2. If that check fails (key-id mismatch, matching id with a bad tag or damaged
   ciphertext, truncation, parse failure), `write()` throws
   `VaultPreservationError` (`code: 'VAULT_UNDECRYPTABLE'`), deletes its temp
   file, and **leaves the existing bytes unchanged**. No caller option bypasses
   this. Only the operator recovery and reset commands in §4.4 replace an
   undecryptable vault, and they move it aside first.
3. A missing file is still writable, so first-time creation and the passkey
   store's `ensureInitialized` keep working.
4. **Convergence keeps the old ciphertext.** When `write()` re-seals a store
   whose header key id differs from the new key's id, it first copies the
   existing file to `<storeFile>.sealed-<oldKeyId>-<iso>`. It keeps the three
   most recent copies and prunes only copies whose key id matches the current
   header.

### 4.4 Operator-approved recovery path

Recovery is operator-initiated only. No boot path, job or session hook triggers
it. Each command requires an explicit `--confirm` flag and an interactive TTY
confirmation. Every command writes a provenance ledger entry with
`caller: "operator-recovery"`.

1. **`instar secrets recover --from-discovered <keyId>`** or
   **`--key-file <path>`**. The operator supplies the key that sealed the vault.
   The command:
   1. verifies authenticated decryption of the vault, and of the passkey store
      if its header matches;
   2. writes the `.sealed-*` preservation copy;
   3. re-seals under the current primary key (`getMasterKey()`, unchanged
      resolution);
   4. checks the result by reading it back through a fresh `SecretStore`.

   If any step fails, the original bytes stay as they are.
2. **`instar secrets restore-key --from-discovered <keyId>`** (alternative to
   re-sealing). Writes the recovered key into the per-agent account, so a
   healthy vault no longer needs re-encryption. This is the only path allowed
   to replace an existing per-agent entry.
3. Before replacing a per-agent entry, **`restore-key` exports the outgoing key**
   to `.instar/machine/secrets-master.key.replaced-<keyId>-<iso>` (0600). The
   preserved-key copies in §4.2 point at these files, so an earlier key stays
   discoverable.
4. **`instar secrets reset-vault --preserve`** is the last resort when the
   diagnosis is `KEY_MISMATCH_UNRESOLVED` and the operator accepts the loss.
   It renames the vault to `.sealed-<keyId>-<iso>` (never deletes it) and lets
   the next write create a fresh vault. It prints the list of
   placeholder-backed config fields that the operator must re-enter. The
   preserved file stays decryptable if the key turns up later, through
   `recover --target <preserved-file>`.

Exclusions: `.sealed-*` and `.provenance.jsonl` siblings must be covered by the
existing exclusions for `secrets/config.secrets.enc*` (backup, git-sync,
never-served file routes). If they are not, add `secrets/config.secrets.enc`
and `secrets/passkeys/store.enc` as prefixes to `KEY_MATERIAL_PATHS`. Add
`machine/secrets-master.key.replaced-*` to `KEY_MATERIAL_FILES` (it is already
under the `machine/` prefix).

### 4.5 Clearer degraded mode

- The wrong-key error gets a stable `code` (`VAULT_KEY_MISMATCH`) and the
  message points to `instar secrets diagnose`.
- `ghToken` keeps spawning without `GH_TOKEN` (behavior unchanged), but reports
  the vault failure once per process and key id instead of once per spawn.
- `Config.secretMerge`'s degradation report includes the header key id and the
  verdict, so the dashboard row is actionable without shell access.

## 5. Tests

Unit tests with the injected fake `KeychainOps`, never the real keychain:

1. **Failed read never clobbers** (regression for H1). The fake per-agent read
   returns `error` and legacy holds key L. `getMasterKey()` does not write the
   per-agent account, and the per-agent entry still holds its original key.
2. **Create-only adoption.** Per-agent `absent`, legacy holds L. Adoption writes
   once. A second adoption attempt against an existing entry is a no-op.
3. **Preservation on authentication failure** (from the previous review). The
   vault header key id matches the resolvable key but the GCM tag (and,
   separately, one ciphertext byte) is flipped. `write({...})` throws
   `VAULT_UNDECRYPTABLE` and the vault bytes are byte-for-byte unchanged
   (compare SHA-256 before and after). No temp file is left behind.
4. **Preservation on key-id mismatch.** The vault is sealed under key K and
   only key J resolves. Direct `write()` throws and the bytes are unchanged.
5. **Convergence keeps a copy.** A store readable only via the alternate key is
   re-sealed by `write()`, and a `.sealed-<oldId>-*` copy decrypts under the old key.
6. **Provenance ledger.** `write()` appends an entry with the correct key id
   and source. The ledger contains no key bytes (assert that neither the hex nor
   the base64 of the key appears).
7. **Discovery (H3).** A key under the `realpath`-spelled account is reported
   by `discoverCandidates()` but not used by `read()`.
8. **Recover.** The operator supplies the correct key: the vault is re-sealed
   under the primary key, the original is preserved, and the read-back succeeds.
   The operator supplies a wrong key: the vault is unchanged.
9. **Reset with preserve.** The vault is renamed, not deleted, and the
   preserved file is byte-identical to the original.
10. **Rollback compatibility** (§6). See below.

## 6. Rollback

All changes are additive. The fix writes no new keychain account spellings and
does not change the v2 format, so a build without this fix still resolves the
same accounts.

- **Account spelling is deliberately unchanged.** The previous attempt
  canonicalized the per-agent account. That is unsafe to roll back: a build
  without canonicalization won't look for a key written only under the
  canonical account. This draft never *writes* an alternate spelling, so
  rolling back can't leave a key on an account the old build doesn't read.
  Alternate spellings are only read, by discovery.
- **`restore-key` writes the recovered key under the existing spelling**
  (`path.resolve`), which every build already reads.
- **`recover` re-seals with `getMasterKey()`**, whose resolution is unchanged
  for a healthy keychain, so the old build reads the result.
- Sidecar files (`.provenance.jsonl`, `.sealed-*`, `.replaced-*`) are ignored by
  older builds and can stay on disk.
- **Rollback procedure:** revert the code. No data migration is needed. If a
  recovery ran, the re-sealed vault is already in the format and under the
  account the older build expects.
- **Rollback test:** with a **symlinked stateDir** (resolved and real paths
  differ), run `recover` under the new build. Then build a `SecretStore` using
  the pre-fix resolution logic (keep a frozen copy of the pre-fix
  `perAgentKeychainAccount`/`getMasterKey` in the test fixture) and assert
  `read()` returns the original secrets. Repeat after `restore-key`.

## 7. Out of scope / follow-ups

- On macOS, `security add-generic-password -w <key>` puts the key in the
  process argv, where other local users can briefly see it through `ps`.
  Moving to stdin or interactive input is worth a separate item.
- Some `SecretStore` constructions do not pass `forceFileKey`
  (`AgentServer` parity sources, `BootSelfKnowledge`, `secret-get.mjs`). The
  dual-candidate read hides this today. It should be made consistent under
  `secret-key-diagnostic-policy`, not here.
- Removing the legacy global slot from adoption entirely. Once the fleet has
  moved past pre-#810 builds, adoption could be retired, which removes the H1
  source completely.

## 8. Open questions

1. Should `getMasterKey()` fail closed on a keychain `error` even when a file key
   exists? Using the file key keeps reads working, but a later `write()` would
   re-seal under the file key. §4.3.4 keeps a copy, so data stays safe, but it
   adds churn.
2. Should the provenance ledger also go to the existing degradation and audit
   sink, so it survives if the `secrets/` directory is lost?
3. For this specific host: does the diagnosis in §4.2.3 find `edbf…` under an
   alternate-spelling account, the legacy slot's history, or another agent's
   account? That determines whether H1 or H3 is confirmed.
