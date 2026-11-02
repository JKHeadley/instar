---
title: "Vault seal provenance, master-key retention and operator-approved recovery"
status: draft
initiative: feedback-8071538f-b84d-43a9-99f9-f416cda8f0f5
cluster: cluster-secret-vault-undecryptable-after-2026-10-05-restart-store-ke
component: "SecretStore / Config.secretMerge"
severity: critical
parent-principle: "Distrust Temporary Success — A Recurrence Is a Root Cause"
related:
  - docs/specs/vault-key-coherence.md
  - docs/specs/keychain-per-agent-master-key.md
  - docs/specs/secret-key-diagnostic-policy.eli16.md
---

# Vault seal provenance, master-key retention and operator-approved recovery

**Status:** Draft. This spec makes no code changes.
**Trigger:** Feedback report on 2026-10-05, v1.3.1319, about two minutes after a server restart.

## 1. Problem

After a restart, the agent's encrypted vault (`.instar/secrets/config.secrets.enc`, v2 format)
names key id `edbfcacac21fdc5c` in its header. Neither key that `MasterKeyManager` can
resolve has that id:

| source   | key id             | on-disk evidence                                          |
|----------|--------------------|-----------------------------------------------------------|
| vault    | `edbfcacac21fdc5c` | `config.secrets.enc` mtime 2026-09-16 10:30 (unchanged)   |
| keychain | `f292f9871f09c0ff` | per-agent and/or legacy entry (the store does not record which)  |
| file     | `e7b0b12b5aaa19c9` | `machine/secrets-master.key` mtime 2026-08-19 11:31       |

Effects observed by the reporter:

- `Config.secretMerge` reports a degradation and config continues with unresolved
  `{secret:true}` placeholders (`src/core/Config.ts:941-957`).
- Every session spawn logs `[ghToken] vault read failed` and runs without `GH_TOKEN`
  (`src/core/ghToken.ts:58-66`). This repeats on every spawn.
- `secret-get.mjs` refuses to read.
- Following policy, the agent did **not** repair or rotate anything. The vault file is intact.

The v2 key-id header (vault-key-coherence) did its job: it showed that the problem is a missing
key, not corruption. It can't answer the operator's two questions, though: **which key sealed the
vault, and when?** And there's **no supported way to recover** besides hand-editing keychain
entries.

Permanent loss is **not yet established**. The sealing key may still exist under a keychain
account that the resolver doesn't check (see §2.2).

## 2. Analysis (from source; no code changed)

### 2.1 What resolution can see

`MasterKeyManager.getCandidateKeys()` (`src/core/SecretStore.ts:162-186`) checks exactly three
places:

1. `instar-secret-store` / `master-key:<path.resolve(stateDir)>` (per-agent keychain)
2. `instar-secret-store` / `master-key` (legacy global keychain)
3. `<stateDir>/machine/secrets-master.key` (file)

Candidates are deduplicated by key bytes. Only one keychain id appears in the report, so either
the per-agent entry equals the legacy entry or one of them is absent. Any key stored under a
**different account string** is invisible to the resolver.

### 2.2 Code paths that can make the sealing key unresolvable

Each of these can leave a vault sealed under a key that a later boot can't find. The evidence
doesn't single one out. The fix in §3 closes all of them.

**A. Adoption overwrites the per-agent entry after a transient keychain read failure.**
`readOsKeychain` returns `null` on *any* error: item not found, a locked login keychain right
after a restart, a user-interaction denial, or the 5 s `execFileSync` timeout
(`SecretStore.ts:209-237`). `getMasterKey()` treats `null` as "absent". If the legacy global
entry is readable, it **adopts** that entry (`SecretStore.ts:142-148`). It does this by calling
`writeOsKeychain`, which **deletes the existing per-agent entry and then adds the legacy key**
(`SecretStore.ts:243-257`). A per-agent key that existed but failed to read for a moment gets
destroyed and replaced with the legacy key. This fits the report: only one keychain id is
visible, which is what you'd expect if per-agent now equals legacy.

**B. Generation overwrites after a transient read failure.** `getFileKey()` generates a new key
when the file key is missing and writes it to the per-agent keychain account. That write is again
delete-then-add (`SecretStore.ts:304-313`), so it has the same failure mode. In this report the
file key existed, so B is less likely here, but the class is the same.

**C. The account string depends on the path spelling.** The per-agent account is
`master-key:${path.resolve(stateDir)}`. `path.resolve` doesn't resolve symlinks. A writer that
reaches the same `.instar` through a different spelling (a symlinked home, `/private/...`
vs `/...`, or `secret-get.mjs`, which resolves `.instar` against the cwd at
`src/templates/scripts/secret-get.mjs:91`) reads and writes a **different keychain account**
while using the same vault file. If that account holds a key, the vault gets sealed under a key
that the canonical spelling never finds.

**D. Documented recovery advice deletes keys.** The recovery note in
`docs/specs/keychain-per-agent-master-key.md` §Recovery tells operators to
`security delete-generic-password … master-key:<abs stateDir>`. That's safe only when the
vault was sealed with the file key. If it was sealed with the keychain key, the note destroys
the only copy.

**E. Writers disagree on `forceFileKey`.** Several constructors omit `forceFileKey`
(`secret-get.mjs`, `BootSelfKnowledge`, `mcpAuthToken`, several `AgentServer` readers) and
`SecretMigrator.mergeConfigWithSecrets` passes `false` explicitly. Reads try both sources, so on
its own this only causes churn: the vault gets re-sealed back and forth between the keychain key
and the file key. Combined with A, B or C, the churn makes it more likely that the vault ends up
sealed under the key that later disappears.

### 2.3 What the system doesn't record

- Which source and account sealed the vault, from which path spelling, at what version and time.
- Whether a keychain entry was replaced, and what it held before.
- Any non-secret history of seal events. The only record is the vault's 8-byte header.

## 3. Proposed fix

Five parts, each reversible on its own. Crypto is unchanged (AES-256-GCM, v2 format). No default
is loosened, and no key material is logged or served.

### 3.1 Seal provenance record (non-secret)

Every `SecretStore.write()` also writes `secrets/vault-seal.json` (atomic tmp+rename, 0600) and
appends one line to `secrets/vault-seal-history.jsonl` (capped at 200 lines). Each record holds:

```json
{ "keyId": "edbfcacac21fdc5c", "source": "keychain", "account": "master-key:/abs/.instar",
  "stateDirResolved": "/abs/.instar", "stateDirReal": "/real/abs/.instar",
  "forceFileKey": false, "writer": "<caller tag>", "pid": 123, "version": "1.3.x",
  "at": "2026-09-16T17:30:00Z" }
```

The key id is a sha256 prefix of a random 32-byte key, so it isn't sensitive. Both files go
under `secrets/`, which is already excluded from backup and sync.

### 3.2 Never destroy a master key

- **Distinguish "absent" from "unreadable".** `KeychainOps.read` returns
  `{ status: 'found' | 'absent' | 'error' }`. On macOS, `security` exit 44 means absent; anything
  else means error. Adoption (A) and generation-to-keychain (B) run **only** on a confirmed
  `absent`. On `error`, resolution falls through without writing and reports
  `SecretStore.keychainReadError`.
- **Archive before overwrite.** `writeOsKeychain` first reads the target account. If it holds a
  *different* key, that key is copied to `master-key-retired:<abs stateDir>:<keyId>` before the
  delete and add. If the archive copy fails, the overwrite is refused.
- **Canonical account.** The per-agent account uses `fs.realpathSync(stateDir)`. During a
  transition, the old `path.resolve` spelling is also tried as a read-only candidate.
- **Refuse to replace a vault that can't be decrypted.** `write()` reads the existing header
  first. If the vault exists and no current candidate matches its key id, the write throws
  `VaultSealedUnderMissingKey` instead of replacing the only copy of the data. This blocks
  `set`, `delete` and direct `write` callers alike, and matches the policy the reporter followed.

### 3.3 Wider read-only candidate discovery

`getCandidateKeys()` also tries the following, all read-only and never generating:

- the `realpath` and `path.resolve` spellings of the per-agent account;
- the account recorded in `vault-seal.json`, if it differs;
- every `master-key-retired:<stateDir>:*` id named in the seal history.

A match through any of these succeeds and reports `SecretStore.dualKeyRead` loudly, with the
account named. It doesn't converge automatically (see 3.4).

### 3.4 Operator-approved recovery CLI

Under `instar machine secrets` (exact placement to be decided in review):

- `diagnose`: prints the vault header key id, the `vault-seal.json` record, the last N history
  lines, every candidate (source, account, key id), file mtimes, and the keychain entry
  modification dates from `security find-generic-password` attributes without `-w`. It doesn't
  read or print any key bytes and doesn't modify anything.
- `try-key --file <hex|base64 file> | --keychain-account <acct>`: test-decrypts the vault in
  memory. Exits 0 on a match and prints only the key id.
- `adopt --file … | --keychain-account …` (requires `--yes`): re-pins the matched key as the
  primary. It archives the current primary under `master-key-retired:*`, writes the matched key
  to the canonical per-agent account and/or the file, then re-seals the vault and records the
  provenance.
- `quarantine` (requires `--yes`): renames the vault to
  `config.secrets.enc.sealed-<keyId>-<ts>` (never deletes it) so that a fresh vault can be
  started. The quarantined file stays loadable by `try-key` and `adopt`.

None of these commands run automatically. The agent may run `diagnose` on its own. The other
commands need operator approval.

### 3.5 Runtime behaviour while mismatched

- A single deduped degradation, `SecretStore.sealedUnderMissingKey`, carries the seal record
  and the candidate ids and points to `instar machine secrets diagnose`.
- `ghToken` logs the failure once per process per vault key id instead of on every spawn.
- The health/self-knowledge surface reports vault state `sealed-key-missing`, with the seal
  record, separately from `absent` and `corrupt`.
- `Config.secretMerge` includes the seal provenance in its reason text. The behaviour
  (non-critical fields continue, critical fields fail the boot) is unchanged.
- Fix the recovery note in `keychain-per-agent-master-key.md` (D): replace "delete the entry"
  with "run `diagnose`, then `adopt`".

## 4. Tests (to be written with the implementation)

All tests use the injected `KeychainOps` fake. None touch a real keychain.

1. **Adoption doesn't clobber on read error:** per-agent read returns `error`, legacy is present,
   so the per-agent entry is untouched and no write happens. With `absent` instead, adoption still
   happens (existing behaviour preserved).
2. **Archive before overwrite:** writing a different key to an occupied account leaves the old key
   readable under `master-key-retired:*`. If the archive write fails, the overwrite is refused.
3. **Reproduces the report:** a vault sealed under key K0, then the keychain swapped to K1 and the
   file key set to K2. `read()` throws the named error, `write()`/`set()` refuse, and the vault
   bytes are unchanged. With K0 present under a retired account, the read succeeds.
4. **Path spelling:** the same vault reached through a symlinked stateDir resolves the same key.
5. **Seal record:** each write produces a matching `vault-seal.json` key id and one history line.
   No key bytes appear in either file.
6. **CLI:** `diagnose` makes no writes. `try-key` gives a correct yes/no. `adopt` re-seals and
   archives the previous primary. `quarantine` renames and never unlinks.
7. **ghToken:** N spawns against a mismatched vault produce one warning.

## 5. Non-goals

- No automatic key rotation, no automatic re-pinning and no automatic vault reset.
- No new key backend and no cross-machine key transfer. SecretSync is unchanged.
- No guess at recovering `edbfcacac21fdc5c` for this reporter. That needs `diagnose` on their
  machine (look for retired or differently spelled accounts and for Time Machine copies of the
  keychain or the key file) followed by an operator-approved `adopt`.

## 6. Rollback

Every part can be reverted on its own. The seal files are additive and ignored by older
versions. Retired keychain accounts are inert. The refuse-to-replace guard is a one-line revert.
The account-spelling change keeps the old spelling as a read candidate, so reverting it doesn't
strand anything.

## 7. Open questions

- Should `write()`'s refusal (3.2) also cover v1 headerless vaults that no candidate decrypts? The
  draft says yes.
- Should the `forceFileKey` disagreement (E) be fixed by making every constructor read the policy
  from config (a single factory), or is the provenance record enough? The draft recommends the
  factory as a follow-up.
- The cap on the seal history and whether retired keychain accounts should ever be pruned
  (the draft says never automatically).
