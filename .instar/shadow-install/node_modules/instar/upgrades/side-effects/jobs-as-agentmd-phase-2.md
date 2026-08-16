# Side-effects review — Phase 2 (default job conversion + asset packaging)

## What changed

Phase 2 converts the 14 prompt-type instar default jobs from inline JSON strings in `getDefaultJobs()` to standalone markdown templates that can be reviewed, diffed, and verified at runtime against the signed lock-file. Script-type and skill-type defaults stay as legacy `getDefaultJobs()` entries — agentmd format is only appropriate for prompt-bearing jobs.

New artifacts:

- **`src/scaffold/templates/jobs/instar/<slug>.md`** — 14 shipped templates, one per prompt-type default. Body is the EXACT bytes of `execute.value`. Frontmatter captures name, description, schedule, priority, expectedDurationMinutes, model, enabled, tags, optional gate, toolAllowlist:"*", unrestrictedTools:true. The "*" + unrestrictedTools:true pair preserves today's full-tool behavior for every shipped default (no behavioral regression). Phase 4 will narrow these per slug.
- **`scripts/regen-default-job-templates.mjs`** — generator that reads `getDefaultJobs()` and writes templates. Run on every default-job edit to keep templates in sync with the canonical source.
- **`src/scheduler/InstallBuiltinJobs.ts`** — new `installBuiltinJobs()` function. Reads templates from `<packageRoot>/dist/scaffold/...` (prod) or `<packageRoot>/src/scaffold/...` (dev), writes per-slug bodies to `.instar/jobs/instar/<slug>.md`, per-slug manifests to `.instar/jobs/schedule/<slug>.json`, copies the signed lock-file from `dist/jobs/instar.lock.json` to `.instar/jobs/instar.lock.json`, and the bundled public key to `.instar/keys/instar-release-pub.pem`.
- **`getDefaultJobs` export** — was a non-exported helper; now exported so the regen script can call it without re-parsing init.ts.
- **PostUpdateMigrator.migrateBuiltinJobs** — invokes installBuiltinJobs on every update. Failures are reported in the migration result, never fatal.
- **init.ts** — fresh-install path also invokes installBuiltinJobs (right after installBuiltinSkills, before CLAUDE.md write).
- **package.json#files** — `src/scaffold` added so the templates ship in the npm tarball.

## Side-effects review (mandatory gate)

### 1. Over-block / under-block

- **Over-block:** none. `installBuiltinJobs` overwrites `.instar/jobs/instar/<slug>.md` on every update — this is the contract for instar-namespace files (the namespace IS managed by updates per the spec's `Concrete Paths`). The user namespace (`.instar/jobs/user/`) is structurally untouched.
- **Under-block:** the operator-disabled state on a default is preserved across updates (the per-slug manifest's `enabled` and `disabledAtBodyHash` are read from the existing manifest before being rewritten). A retired default has its body removed and its manifest marked retired+disabled+timestamped, so Phase 4 Dashboard can surface it.

### 2. Level-of-abstraction fit

`installBuiltinJobs` is a pure file-system shaper. It does not invoke the scheduler, does not touch state.json, does not emit events. It writes files and returns a report. This keeps it composable: both init and PostUpdateMigrator call it; tests run it against a synthetic workspace; future Phase 5 `instar jobs migrate` will also call it as part of the migration sequence.

The destructive operations (template removal on retire, stale lock-file cleanup) go through `SafeFsExecutor.safeUnlinkSync` with explicit operation strings, satisfying the destructive-tool funnel gate.

### 3. Signal-vs-authority compliance

The signed lock-file remains the trust authority — `installBuiltinJobs` is just the courier. It copies the lock-file from `<packageRoot>/dist/jobs/` to `.instar/jobs/` without inspecting or modifying its contents. The runtime verifier (Phase 1c-runtime) reads the lock-file and decides trust. Phase 2 does NOT touch the lockTrust decision path.

### 4. Interactions

- **Phase 1c-runtime** — the bundled public key copy step keeps the verifier able to validate lock-files on every update (no chicken-and-egg if the public key is rotated mid-rollout).
- **Phase 1c-build** — when a signing key is configured, `npm run build` produces `dist/jobs/instar.lock.json`; `installBuiltinJobs` copies it. When no signing key is configured (current pre-GHA-secret state), the signer skips lock-file generation; `installBuiltinJobs` removes any stale lock-file from agent disk so the runtime sees `state: absent` → `lockTrust=untrusted-no-lockfile`.
- **Legacy `jobs.json` seeding** — init.ts still calls `getDefaultJobs()` and writes the legacy `jobs.json`. The JobLoader already handles `schedule/<slug>.json` shadowing `jobs.json` entries with the same slug — no conflict. Phase 3 will migrate `jobs.json` entries that match an agentmd template to `origin:instar` form and drop the body; Phase 5 auto-runs this.
- **`origin:instar` namespace ownership** — invariant 4 of the Seamless Migration Guarantee (PR #180) is verified by the `NEVER touches .instar/jobs/user/` test plus the symlink-refusal test.
- **Idempotency** — installer is idempotent. Run-twice test asserts the on-disk content is byte-stable across repeated invocations.

### 5. Rollback cost

Trivial. Removing `installBuiltinJobs` call from init + PostUpdateMigrator restores prior behavior. Agents that already have `.instar/jobs/instar/` populated keep the files (the loader handles them via Phase 1a path); no on-disk corruption.

### 6. Seamless Migration Guarantee compliance

This PR ships the Seamless Migration Guarantee fixtures' first hook: installer behavior under the `pristine` shape (fresh agent, default-only state). The dedicated guarantee suite (`tests/integration/migration-guarantee.test.ts`) lands in Phase 3 with the migration script. Phase 2's installer tests assert:

- Invariant 4 (user namespace untouched) — `NEVER touches .instar/jobs/user/` test
- Symlink refusal (defense-in-depth for invariant 4) — `refuses to install if .instar/jobs/user/ is a symlink`
- Idempotency boundary for the installer — `is idempotent — running twice produces the same on-disk state`
- Retired-default flow (no orphan state) — `retires a default that is removed from the shipped templates`

## Test coverage

`tests/unit/scheduler/InstallBuiltinJobs.test.ts` — 10 cases:

1. Installs each shipped template + per-slug manifest
2. Port-sentinel substitution (`:-4042}` → `:-<agentPort>}`)
3. Preserves operator-disabled state on update
4. Retires defaults removed from templates
5. NEVER touches `.instar/jobs/user/` (invariant 4)
6. Refuses install if user dir is a symlink (defense-in-depth)
7. Copies signed lock-file + bundled public key when present
8. Removes stale lock-file when no signed file ships
9. Returns error when templates dir is absent or empty
10. Idempotent — run-twice produces byte-stable on-disk state

All 10 tests pass locally.

## What is NOT in this PR

- **Drift classifier** — the spec mentions populating `significantChanges` in the lock-file at build time. That's a Phase 4 Dashboard concern; the lock-file format already accommodates it (optional field). Will land with the Dashboard rewrite.
- **`instar jobs migrate` CLI** — Phase 3.
- **Auto-migration on update** — Phase 5 (PostUpdateMigrator will auto-run the migration script when `jobs.json` + no `.migration-complete.json`).
- **Full Seamless Migration Guarantee suite** — Phase 3 ships the suite with the migration script.
- **Per-slug narrow allowlists** — every shipped default currently has `toolAllowlist: "*"`. Narrowing is a per-slug review Phase 4 will run.
