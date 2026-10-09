# Side-Effects Review — Key material is never served, backed up or listed (a2a-single-agent-identity §5)

**Version / slug:** `files-never-serve-key-material`
**Date:** `2026-10-09`
**Author:** Echo (instar-dev agent)
**Second-pass reviewer:** reviewer subagent (see "Second-pass review" below)

## Summary of the change

Section 5 of `docs/specs/a2a-single-agent-identity.md` (converged, approved). One new
module, `src/core/keyMaterialPaths.ts`, holds the list of key-bearing files under
`.instar/` — the agent identity (`identity.json` and its `.superseded-*` / `.invalid-*` /
temp siblings), the legacy threadline mirror, the threadline HMAC / invitation / token files,
the dedicated SSH keys, the headless key vault (`local-state/`), origin-session credentials,
the inbound-delivery and conversation-bind secrets, the manifest signing key, the machine
key pair, the remediation key vault's flatfile and the telemetry HMAC secret. Four consumers derive their own spelling from that ONE list: the dashboard file
routes' code-owned `NEVER_SERVED_PREFIXES` (`src/server/fileRoutes.ts`), `BackupManager`'s
never-backup prefix set, `GITIGNORE_ENTRIES` at init plus `migrateGitignore` for existing
agents (`src/core/MachineIdentity.ts`, `src/core/PostUpdateMigrator.ts`), and the git-sync
`FileClassifier`'s secret patterns.

The file routes also close the §5.2 gaps: `blockedFilenames` and the never-served check run
on the requested AND the resolved path in read/download/list/link; `list` resolves each entry
and OMITS one whose realpath fails or is denied; `link` resolves before minting; a `realpath`
failure refuses (403) instead of a 500; and read/download open the file FIRST, `fstat` the
descriptor, refuse unless its device+inode equals the stat taken at validation, refuse a
multi-link inode that equals any listed key file, and serve FROM THAT DESCRIPTOR
(`handle.readFile()` / `handle.createReadStream()`), never a by-path re-open.

`src/commands/init.ts` gets a one-line fix the §5.4 walk found: the standalone init path
called `ensureGitignore(stateDir)`, which wrote the project-relative entries into
`.instar/.gitignore` where they match nothing; it now also calls `ensureGitignore(projectDir)`
like the other two init paths. The CLAUDE.md template and migrator carry a "Never served" row.

Tests: `tests/unit/file-routes-never-served-key-material.test.ts` (static list parity on all
four surfaces + the route behaviour by direct path, symlink, hard link, swapped descriptor,
dangling symlink, config narrowing), `tests/integration/file-routes-never-served-walk.test.ts`
(the §5.4 walk: real init + real sealer/installer pairing + every in-tree key producer, then
every 0600 / private-field / key-named file asserted refused, excluded, ignored, classified),
`tests/e2e/files-never-serve-key-material-alive.test.ts` (production `AgentServer` boot: 200 on
an allowed file, 403 on the identity, migration idempotency).

## Decision-point inventory

- `isNeverServed` / `NEVER_SERVED_PREFIXES` (`src/server/fileRoutes.ts`) — modify — the
  enumerated deny gains the key-material prefixes.
- `validatePath` (`src/server/fileRoutes.ts`) — modify — carries the resolved `stat`; a
  non-ENOENT realpath failure now refuses (403) instead of 500.
- `openCheckedDescriptor` (`src/server/fileRoutes.ts`) — add — descriptor identity proof
  (device+inode) and the multi-link key-inode refusal; read/download consume it.
- `resolveListEntry` (`src/server/fileRoutes.ts`) — add — per-entry admission for `list`
  (omit on denied/unresolvable/blocked requested-or-resolved path).
- `GET /api/files/link` — modify — full `validatePath` resolution before minting.
- `BLOCKED_PATH_PREFIXES` (`src/core/BackupManager.ts`) — modify — key prefixes in both spellings.
- `DEFAULT_SECRET_PATTERNS` (`src/core/FileClassifier.ts`) — modify — key prefixes as globs.
- `GITIGNORE_ENTRIES` / `ensureGitignore` (`src/core/MachineIdentity.ts`) — modify — key entries.
- `PostUpdateMigrator.migrateGitignore` / `migrateClaudeMd` — modify — key entries both repos; the "Never served" row.
- standalone `initProject` gitignore step (`src/commands/init.ts`) — modify — also writes the project `.gitignore`.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- A document the operator placed under one of the listed PREFIXES — e.g. a note saved as
  `.instar/identity.json.notes.md` or anything inside `.instar/local-state/` — is refused by the
  Files tab. Spec §Rollback states this cost explicitly: a false positive is fixed by moving
  the document, never by serving keys. The prefixes are narrow (`identity.json`,
  `origin-sessions-`, `machine-ssh/`, `local-state/`, …) and every listed directory is one
  Instar itself owns for key storage.
- `realpath` failure now 403s instead of 500. A transient EACCES on an allowed file reads as
  "could not be resolved" rather than an internal error; the file is not served either way,
  so nothing that used to work stops working — only the status code changes (500 → 403).
- A multi-link file whose inode equals a listed key file is refused even when reached through
  an innocent name outside `.instar/`. That is the intended refusal; an unrelated multi-link
  file (asserted in the unit test) is still served.
- `list` omits a dangling symlink and a symlink into denied material instead of listing the
  name. An operator who expected to SEE the dangling name will not; nothing was readable
  through it before either.
- `conversations.json`, `trust-profiles.json`, thread history, `AGENT.md`, `config`-adjacent
  docs: asserted servable in all three tiers (no over-block on the audit surfaces).

---

## 2. Under-block

**What failure modes does this still miss?**

- A key file produced by a path the §5.4 walk does not drive. The walk drives the real init
  (machine key pair, manifest key, pairing session), the real pairing sealer/installer (the
  agent identity), and these runtime producers by name: `InvitationManager`,
  `SecureInvitationManager`, `loadOrCreateDeliveryHmacKey`, `ensureBindTokenSecret`,
  `ManifestIntegrity`, `MachineSshIdentity`, `WorktreeKeyVault` (flatfile),
  `RemediationKeyVault` (env-passphrase flatfile) and `TelemetryAuth.provision` — the last
  two were ADDED after the second-pass review found `remediation-keys.age` and
  `telemetry/local-secret` neither driven nor listed — plus the relay-token writer and the
  legacy threadline mirror/inbox key written through the same owner-only writer. This is the
  producer set a grep for `mode: 0o600` / `writeFileAtomicOwnerOnly` across `src/` yields
  today; it is a list maintained by audit, not a proof of completeness. A generator added
  later that writes somewhere new fails the walk only if it is also called from the walk:
  one wired into init is caught automatically (the walk boots the real init); one reached
  only at runtime must be added to the walk's step 3 (the test header says so).
- `telemetry/install-id` (a bare UUID, 0600) and `state/identity-epochs.json` (public
  verification material, 0600) are excused from the walk by a per-file proof predicate
  re-run on the live bytes, and stay servable on purpose — the list is kept to key material.
- A key file written OUTSIDE `.instar/` (e.g. `~/.ssh`) is out of scope by design — the Files
  tab is jailed to the project directory and the list is `.instar/`-relative.
- The hard-link check compares the opened inode against the static `KEY_MATERIAL_FILES`
  (now including `machine/secrets-master.key` and `secrets/passkeys/store.enc`, added on the
  reviewer's finding) PLUS, on the same rare `nlink > 1` path, a `readdir` of `machine-ssh/`
  (generation-named `<kind>-ed25519-g<N>` keys) and of the stateDir root for
  `origin-sessions-<digest>` files — the two name shapes a static list cannot enumerate. What
  remains outside the inode check: a hard link to a `.superseded-*` / `.invalid-*` / temp
  sibling of `identity.json` (not enumerated per request). Every such sibling is still refused
  by every PATH check; only a hard link to it under an innocent name OUTSIDE `.instar/`
  escapes. Hard links require write access on the same filesystem as the agent home, i.e. the
  operator's own account — the cost is stated, not hidden.
- The descriptor proof defeats a symlink swap between check and open; it does not defend
  against a file being REPLACED IN PLACE (same inode, rewritten bytes) — that is not a
  confused-deputy problem, it is the operator editing their own file.

---

## 3. Level-of-abstraction fit

This is a low-level, enumerated, deterministic deny at the serving chokepoint, which is the
right layer: the question "is this byte sequence a private key?" has an exact answer here
(the file IS the key file by path or inode), so no higher-level reasoning gate should own it.
The existing primitives are reused rather than re-implemented — `isNeverServed` for the deny,
`validatePath` for traversal/realpath, `BackupManager`'s prefix set, `FileClassifier`'s
patterns, `addGitignoreEntry` for migration. The one new abstraction (`keyMaterialPaths.ts`)
exists so four surfaces read ONE list and cannot drift; the walk test is the instrument that
can disagree with that list.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is an enumerated floor, not a heuristic: exact path prefixes and
      inode equality, over files Instar itself writes. (Spec §5.1: "Exact-path access control,
      not a meaning filter — Signal vs. Authority does not apply to an enumerated floor.")
- [ ] ⚠️ Yes, with brittle logic — STOP.

The deny decides on identity (path prefix, device+inode), never on content interpretation.
There is nothing to misjudge about a listed path; the only failure class is an INCOMPLETE
list, and that is covered by the walk test rather than by giving the gate judgment. No config
key can loosen it (`PATCH /api/files/config` narrows `allowedPaths`; the deny is consulted
independently) — by design, since a loosening lever would be the first thing a compromised
operator session reaches for.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Every decision here is
enumerable (a listed path, an equal inode) — an invariant, not a judgment.

---

## 5. Interactions

- **Shadowing:** `isNeverServed` already ran before `allowedPaths`; the new prefixes join the
  same list, so ordering is unchanged. In `list`, the per-entry resolution runs where the
  `blockedFilenames` + stat-skip used to run; the output shape is identical for every entry
  that was listed before and is still admissible. In `link`, the full `validatePath` replaces
  the lighter `checkRelativePathAllowed` pre-check; every refusal the pre-check produced is
  still produced (the pre-check is the first layer inside `validatePath`), plus the resolved-
  path refusals. `isNeverEditable` already included `isNeverServed`, so the save route refuses
  the new prefixes with no change.
- **Double-fire:** the backup exclusion and the classifier exclusion both apply to the same
  files; both are "skip", so a double-skip is harmless. The migrator's gitignore step and
  `ensureGitignore` at init may both write the same entries; both are idempotent (existence
  check), asserted by the E2E double-run.
- **Races:** the check-then-serve race is the one this change CLOSES (descriptor proof). The
  `list` route performs realpath per entry (≤500) — more syscalls than before, bounded by the
  existing 500-entry cap.
- **Feedback loops:** none — nothing here writes state that feeds a later decision.
- **`IDENTITY_AUTO_ACCEPT_PROTECTED_PATHS`** already denied `.instar/machine/` and
  `.instar/identity.json` on the routes; the new list overlaps it for those two and extends to
  the rest. Overlap is additive, never contradictory.

---

## 6. External surfaces

- Other agents on the same machine: none — the file routes serve this agent's project dir only.
- Users of the install base: the dashboard Files tab now returns 403 on key files that were
  previously readable through a symlink or a crafted listing; direct paths were already
  refused for `identity.json`/`machine/`. A 500 on an unresolvable path becomes a 403. The
  "Never served" CLAUDE.md row (template + migration) tells the agent to explain a 403 there
  as correct.
- External systems: none.
- Persistent state: `.gitignore` (project) and `.instar/.gitignore` gain entries on update —
  additive lines, idempotent. No other durable state.
- Timing/runtime: the descriptor proof relies on `fstat` device+inode — stable on every
  filesystem Instar runs on (APFS, ext4); on a filesystem that reports `nlink` unreliably the
  worst case is an extra dozen `stat`s per request, never a false admit.
- **Operator surface:** no new operator-facing action — the change only refuses. "No
  operator-facing actions" applies.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No `dashboard/*` file is touched; the dashboard Files
tab receives the same 403 JSON shape it already renders for never-served paths.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**, for a security-boundary reason: key material lives on the disk
of the machine that holds it, and the deny guards THAT machine's serving, backup, gitignore
and sync surfaces. The list itself is code (identical on every machine at the same version);
no state replicates because there is no state. Multi-machine consequence worth stating: the
gitignore + classifier arms are exactly what keep a key from riding git-sync to a sibling, so
this change REDUCES cross-machine leakage rather than needing a replication path. No
user-facing notices (nothing to one-voice-gate), no durable state to strand on transfer, no
generated URLs (the `link` route mints the same relative dashboard URL it did before and
refuses for denied paths).

---

## 8. Rollback cost

- **Hot-fix release:** revert the code; ship as the next patch. Spec §Rollback: "no lever by
  design; a false positive is fixed by moving the document, not by serving keys."
- **Data migration:** none. The added `.gitignore` lines are inert if the code is reverted and
  harmless to leave.
- **Agent state repair:** none. The CLAUDE.md row describes a 403 that, after a revert, would
  simply stop occurring.
- **User visibility:** a reverted install would again serve key material through the symlink/
  listing gaps — that is the regression the floor exists to prevent, so the back-out is a
  deliberate operator decision, never automatic.

---

## Conclusion

The review produced two rounds of design change. First, the §5.4 walk disagreed with the
list twice and both disagreements were real — the manifest signing key (`state/.manifest-key`)
and the machine key pair (`machine/`) were not in the spec's §5.1 enumeration and are now on
the list, and the standalone init path was writing the project-relative gitignore entries into
the wrong file (fixed in `init.ts`). Second, the independent second-pass review found two
producers the walk never drove (`remediation-keys.age`, `telemetry/local-secret`): both are
now listed on all four surfaces and driven in the walk, two more static names joined the
inode set, and the hard-link check now enumerates the generation-named SSH keys and the
origin-session files at request time. The remaining findings are the stated costs (an operator
document under a listed prefix must be moved; a hard link to an `identity.json` sibling under
an innocent name outside `.instar/` is not inode-checked) and are recorded in §2. Clear to
ship once the second-pass reviewer confirms the resolutions.

---

## Second-pass review (if required)

**Reviewer:** reviewer subagent (independent read)
**Independent read of the artifact: concern**

Independent audit against the diff, `src/core/keyMaterialPaths.ts`, `src/server/fileRoutes.ts`
(validatePath, openCheckedDescriptor, resolveListEntry, the four handlers) and the three test
tiers (`tests/unit/file-routes-never-served-key-material.test.ts` re-run: 19/19 green). The
over-block, signal-vs-authority, §5 Interactions and §7 multi-machine conclusions hold. The
concern is the §2 under-block inventory and the §5.4 walk's producer coverage: two in-tree
key producers under `.instar/` are neither driven by the walk nor covered by the list, and the
artifact's claim that the walk drives "every in-tree generator found by audit" is therefore
not true as written.

- **Concern 1 — `remediation-keys.age` is served, synced and backed up.**
  `src/remediation/RemediationKeyVault.ts:392` writes the env-passphrase flat-file key vault
  to `path.join(stateDir, 'remediation-keys.age')` with mode 0600 (`:280`, `SECURE_FILE_MODE`
  at `:51`). Probed against the built predicates: `isNeverServed('.instar/remediation-keys.age')`
  → `false`; `FileClassifier.classify(...)` → `llm` (git-sync WOULD replicate it); it is in no
  gitignore entry and no backup prefix. It is the same class as `local-state/keys.enc`, which
  the list does include (`keyMaterialPaths.ts:48,84`). The walk never constructs the vault on
  that backend, so the "a key file the list does not cover fails the build" guarantee is blind
  to it. Resolution: add `remediation-keys.age` to `KEY_MATERIAL_PATHS` and `KEY_MATERIAL_FILES`,
  and drive `RemediationKeyVault` (env-passphrase backend) in the walk's step 3.
- **Concern 2 — `telemetry/local-secret` is served.** `src/monitoring/TelemetryAuth.ts:28,63`
  writes a 32-byte HMAC secret to `.instar/telemetry/local-secret` (0600). Probed:
  `isNeverServed('.instar/telemetry/local-secret')` → `false` (read/download/link/list reach
  it); the classifier already says `never-sync`, so only the route floor and backup/gitignore
  are open. The walk does not drive `TelemetryAuth`, and its name predicate (`\.secret$`) would
  not match `local-secret` even if it did (the 0600 arm would). Resolution: add
  `telemetry/local-secret` to the list (and `KEY_MATERIAL_FILES`), drive `TelemetryAuth.ensure`
  in the walk.
- **Concern 3 — §2 understates the hard-link inode gap.** §2 names only a `.superseded-*`
  sibling as outside `KEY_MATERIAL_FILES`. Also outside it: `machine/secrets-master.key`
  (`src/core/SecretStore.ts:120` — the master key for the encrypted secret store), every
  `machine-ssh/<kind>-ed25519-g<N>` private key (`src/core/MachineSshIdentity.ts:84`, generation-
  named so not statically enumerable), `secrets/passkeys/store.enc`
  (`src/core/PasskeyCredentialStore.ts:45`) and the `origin-sessions-<digest>.json` file
  (`OriginSessionRegistry.ts:57`). All are refused by every PATH check; only a hard link under an
  innocent name outside `.instar/` escapes (`fileRoutes.ts:337-350` compares the opened inode
  against `KEY_MATERIAL_FILES` only). Resolution: add `machine/secrets-master.key` and
  `secrets/passkeys/store.enc` to `KEY_MATERIAL_FILES` (static names), and either readdir
  `machine-ssh/` on the rare `nlink > 1` path or state the SSH-key and origin-session cases
  explicitly in §2 as the same operator-write-access cost.
- **Concern 4 — the "every in-tree generator found by audit" sentence (§2, first bullet).**
  Rewrite to name the producers actually driven (the walk's step 3 list) and the two above as
  added, so the artifact does not certify a completeness the grep (`mode: 0o600` /
  `writeFileAtomicOwnerOnly` across `src/`) does not support.

Non-blocking notes (verified, no change required):
- Over-block: none found. `conversations.json`, `trust-profiles.json`, thread history,
  `invitations.json`, `AGENT.md` and ordinary docs stay servable (unit `:92-100`, walk `:273-278`,
  e2e `:97-103`). The `realpath` non-ENOENT → 403 change (`fileRoutes.ts:292-298`) only
  re-codes what was a 500 (ELOOP/EACCES); a dangling symlink still answers 404 (lstat succeeds,
  realpath ENOENT), so no previously-served case stops serving.
- Under-block through the four routes by PATH: none found. Every handler goes through
  `validatePath` (requested-path deny at `:220`, resolved-path deny at `:283`, resolved
  `blockedFilenames` at `:649`/`:992`/`:1060`), `list` admits per entry via `resolveListEntry`
  (`:368-388`) in both the root and the sub-directory branch, `read`/`download` serve from the
  proven descriptor (`:678-690`, `:1014-1029`), `link` resolves before minting and its
  `editable` flag consults the resolved path (`:1074-1077`). `isNeverServed` case-folds
  (`:151-158`), so the macOS case gap is closed.
- Signal-vs-authority: an enumerated floor (prefix list + device/inode equality); no heuristic.
- §5 Interactions and §7 posture match the code: `isNeverEditable` delegates to `isNeverServed`
  (`:458`), the list is code with no replicated state, the gitignore/classifier arms are what
  keep the key off a sibling.
- (f) Deferral scan: neither the artifact nor `upgrades/next/files-never-serve-key-material.md`
  contains a pattern the pre-commit check matches (`scripts/instar-dev-precommit.js:901-914`:
  "deferred", "out of scope today/for now", "not in this PR", "follow-up"); the artifact's
  "out of scope by design" (§2) is not a match, and the check reads the SPEC (`:645,666`), not
  the artifact.

**Author's resolution of the concerns (same change, before commit):**

- Concern 1 — `remediation-keys.age` added to `KEY_MATERIAL_PATHS` and `KEY_MATERIAL_FILES`
  (`src/core/keyMaterialPaths.ts`); the walk now drives
  `RemediationKeyVault.forStateDir(stateDir, { forceBackend: 'env-passphrase', … })` and
  asserts the file is found.
- Concern 2 — `telemetry/local-secret` added to both lists; the walk drives
  `new TelemetryAuth(stateDir).provision()`; `telemetry/install-id` (a bare UUID) is excused by
  a UUID-shape predicate, re-run on the live bytes, so it stays servable without hiding a key.
- Concern 3 — `machine/secrets-master.key` and `secrets/passkeys/store.enc` added to
  `KEY_MATERIAL_FILES`; `openCheckedDescriptor` now builds its inode candidates from the static
  list PLUS a `readdir` of `machine-ssh/` and of the stateDir root for `origin-sessions-*`
  (`keyInodeCandidates` in `src/server/fileRoutes.ts`), on the `nlink > 1` path only. §2
  states the remaining `identity.json`-sibling case as a cost.
- Concern 4 — the §2 sentence now names the producers the walk drives and says the list is
  maintained by audit, not a proof of completeness.

**Reviewer re-read after the resolutions: concur**

Each resolution verified from the code, not the description; the walk and unit files re-run
green together (26/26).
- Concern 1/2 closed: `remediation-keys.age` and `telemetry/local-secret` are in
  `KEY_MATERIAL_PATHS` (`src/core/keyMaterialPaths.ts:69,73`) and `KEY_MATERIAL_FILES`
  (`:99,100`); the walk drives `RemediationKeyVault.forStateDir(..., forceBackend:
  'env-passphrase')` and `new TelemetryAuth(stateDir).provision()`
  (`tests/integration/file-routes-never-served-walk.test.ts:164-165`) and asserts both files
  are found (`:220-221`). `telemetry/install-id` is excused only while its live bytes match the
  UUID-shape predicate (`:71`, re-run at `:192-195`), so the excuse cannot rot into hiding a key.
- Concern 3 closed: `machine/secrets-master.key` and `secrets/passkeys/store.enc` are in
  `KEY_MATERIAL_FILES` (`:97-98`); `openCheckedDescriptor` now iterates
  `keyInodeCandidates(stateDir)` (`src/server/fileRoutes.ts:339`, builder at `:365-378`) = the
  static list + a `readdir` of `machine-ssh/` (`KEY_MATERIAL_DYNAMIC_DIRS`,
  `keyMaterialPaths.ts:111`) + stateDir-root names starting `origin-sessions-`
  (`KEY_MATERIAL_ROOT_NAME_PREFIXES`, `:112`), on the `nlink > 1` path only; a missing dir is
  skipped, never a 500.
- Concern 4 closed: §2 now names the driven producers and calls the list audit-maintained,
  not a completeness proof.
- Non-blocking: the `machine-ssh/` readdir also enumerates its non-key files
  (`directional-proofs.json`, `peer-admissions.json`, `identity.json` metadata) as inode
  candidates — a hard link to one of those is refused too. That is an over-refusal on a
  never-served directory, not an admit, so it is within the stated floor.

---

## Evidence pointers

- `tests/unit/file-routes-never-served-key-material.test.ts` — static parity + route behaviour.
- `tests/integration/file-routes-never-served-walk.test.ts` — the §5.4 walk over a real init + pair (7 tests).
- `tests/e2e/files-never-serve-key-material-alive.test.ts` — production boot, feature-is-alive, migration idempotency.
- Existing coverage re-run green: `fileRoutes-never-served`, `fileRoutes-link-allowed-paths`,
  `file-editor-never-editable-bypasses`, `identity-protected-files-routes`, `file-viewer-e2e`,
  `BackupManager-*`, `backup-manager`, `file-classifier`, `PostUpdateMigrator-gitignore`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This change adds no self-triggered
controller (no loop, monitor, sentinel, reaper, scheduler or recovery path; it only refuses
requests synchronously), so the `unbounded-self-action` class is not touched either.
