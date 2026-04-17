# Side-Effects Review — BackupConfig plumbing (Phase A commit 2)

**Version / slug:** `pr-gate-phase-a-commit-2-backupconfig-plumbing`
**Date:** `2026-04-17`
**Author:** `Echo (instar-developing agent)`
**Second-pass reviewer:** `required — will append after build`

## Summary of the change

Lands the source-side plumbing that makes `config.backup.includeFiles` actually reach `BackupManager`. Before this commit, `BackupManager` accepted a `Partial<BackupConfig>` constructor arg but no production caller ever passed one, AND the merge used object-spread semantics (`{ ...DEFAULT_CONFIG, ...config }`) so any user-supplied `includeFiles` would REPLACE the identity/memory defaults rather than extend them. A migrator wanting to add `.instar/state/pr-pipeline.jsonl*` to the backup set could not do so without also re-specifying AGENT.md/USER.md/MEMORY.md/jobs.json/users.json/relationships/shared-state.jsonl*; any omission would silently strip those from snapshots. This commit ships the plumbing AND fixes the merge semantics together.

Files touched:
- `src/core/types.ts` — adds JSDoc to `BackupConfig.includeFiles` clarifying union semantics and the `.instar/secrets/` defense; adds optional `backup?: Partial<BackupConfig>` on `InstarConfig`.
- `src/config/ConfigDefaults.ts` — adds `backup: { includeFiles: [] as string[] }` to `SHARED_DEFAULTS` (empty array because the **defaults** in `BackupManager.DEFAULT_CONFIG` are still authoritative; the config key exists so migrators can extend it).
- `src/core/BackupManager.ts` — constructor now unions `config.includeFiles` with `DEFAULT_CONFIG.includeFiles` via `Array.from(new Set([...]))` instead of replacing. Deduplication is a pure set property; everything else in the merge (`enabled`, `maxSnapshots`) preserves its prior override semantics via object-spread.
- `src/server/routes.ts` (3 sites) — `/backups` GET/POST and `/backups/:id/restore` now pass `ctx.config.backup` through as the BackupManager constructor's second arg.
- `src/commands/backup.ts` (3 sites) — `create`/`list`/`restore` CLI commands pass `config.backup` the same way.
- `tests/unit/backup-manager.test.ts` — replaces the "uses custom includeFiles" test (which asserted replace semantics) with three union-aware tests: union verifies user + default entries, undefined config verifies no crash, duplicates verify set-dedup.

This is commit 2 in the Phase A landing of `docs/specs/PR-REVIEW-HARDENING-SPEC.md`. It has no runtime behavior change for anyone who isn't passing `config.backup` (i.e. everyone today), and a well-defined semantic change for anyone who starts passing it (extensions instead of replacement).

## Decision-point inventory

- **None.** This commit adds no new decision points. The existing hard-invariant safety guards (`BLOCKED_FILES` equality check, `BLOCKED_PATH_PREFIXES` prefix check added in commit 1) are unchanged. The merge-semantics change on `includeFiles` is a data-model refinement, not a judgment call.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable at the decision-point level.

One user-facing semantic shift: a user who previously passed `BackupManager(dir, { includeFiles: ['only-these.md'] })` expecting only that file in the snapshot will, after this change, also get the defaults (AGENT.md, USER.md, MEMORY.md, jobs.json, users.json, relationships/, shared-state.jsonl*). This is the intended direction — the whole point of the commit is that users can't accidentally strip defaults — but it is a behavior change on the class constructor. No production caller today passes `includeFiles`, so no production surface is affected. The only touched test at that boundary (`"uses custom includeFiles"`) is updated to reflect the new semantics.

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable at the decision-point level.

Noted related limitations, pre-existing and unchanged by this commit:
- The `.instar/secrets/` prefix defense (commit 1) protects against user-config-driven secrets entries but not symlinks that point into the secrets tree. Out of scope for this commit; noted as future work in commit 1's artifact and the spec's iter5 non-blocking clarifications list.
- `InstarConfig.backup` is declared as `Partial<BackupConfig>` — an agent's `config.json` could technically set `backup.enabled: false` and disable auto-backups. This was already possible via `BackupManager`'s prior constructor but was not a supported config path. Making it reachable from `config.json` is a deliberate consequence of the plumbing; no known caller would set this to `false`, and doing so has the same effect as setting `monitoring.autoBackup.enabled: false` would hypothetically have.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The spec explicitly called out that before this plumbing exists, `migrateBackupManifest()` (a later Phase A commit) would be writing to a config path that has no consumer. This commit adds the consumer (`BackupManager` reading `config.backup`), the config-surface registration (`ConfigDefaults.SHARED_DEFAULTS.backup`), the type declaration (`InstarConfig.backup?`), and the six production call-sites — all at the layer they belong. Nothing is pushed to a higher layer (the `BackupManager` itself is the correct authority for deciding what to snapshot) and nothing is pushed lower (no filesystem-level gate is appropriate here).

The union-vs-replace merge is at `BackupManager.constructor`, which is the single point where defaults and user overrides combine. That's the correct layer for the semantic.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface. It is a data-model plumbing change: adds a config key, wires it through six call-sites, and switches one merge from spread-replace to set-union.

Narrative: there is no detector and no authority in this commit — the new behavior is mechanical merging of two string arrays into a deduplicated union. The existing structural validators (`BLOCKED_FILES`, `BLOCKED_PATH_PREFIXES`) continue to act on the merged result and are unchanged. Per `docs/signal-vs-authority.md`, the principle applies to judgment decisions, not type-level and config-level plumbing.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** none. The merge happens in the constructor; `resolveIncludedFiles()`, `BLOCKED_FILES`, and `BLOCKED_PATH_PREFIXES` all act on the merged result exactly as they did before. The `shared-state.jsonl*` gate tied to `isIntegratedBeingEnabled` still fires in `resolveIncludedFiles` — union doesn't bypass it.
- **Double-fire:** none. The merge is a single synchronous operation in the constructor. Deduplication via `new Set<string>` guarantees each entry appears at most once in the resulting list, so the per-entry snapshot loop cannot double-read a path.
- **Races:** none. Constructor is synchronous; `this.config.includeFiles` is set before any async method can read it. `createSnapshot` is still synchronous per commit 1's artifact. The new `ctx.config.backup` pass-through in `routes.ts` and `commands/backup.ts` is a plain object-property read on an already-loaded config; no lock or lifecycle concern.
- **Feedback loops:** none. No component reads `config.backup.includeFiles` as a function of a prior snapshot.
- **Interaction with `PostUpdateMigrator`:** `applyDefaults()` in `ConfigDefaults.ts` is an add-missing-keys deep merge — it will ADD `config.backup = { includeFiles: [] }` to existing configs that don't have it. It will NOT overwrite user-added entries in an existing `config.backup.includeFiles` (per comment at `ConfigDefaults.ts:115`, arrays are treated as opaque leaves and left alone if present). Correct behavior: migrator step 4 (Phase A commit 4, not this one) will do the actual merge-into-includeFiles in a separate code path and explicitly preserve user entries; this commit just guarantees the key exists for that future code path to operate on.
- **Interaction with `Config.loadConfig`:** `loadConfig` reads the JSON file directly and applies defaults via `applyDefaults`. If a user's `config.json` has `backup.includeFiles`, `loadConfig` returns it; the routes then pass it to `BackupManager`. End-to-end path verified.
- **Interaction with existing BackupManager tests:** three other tests pass `includeFiles` arrays (the BLOCKED_FILES/BLOCKED_PATH_PREFIXES tests). Their assertions only check that blocked entries are absent and AGENT.md is present; both still hold under union (defaults are now also included but the assertions don't preclude that). Verified empirically — all 44 tests in `backup-manager.test.ts` and 3 in `BackupManager-sharedState.test.ts` pass.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** after an `npm update`, existing agents pick up this change. Their `config.json` does not contain `backup` yet, so `config.backup` is `undefined` → `BackupManager` behaves exactly as it did before (defaults only, no user extensions). No observable change.
- **Users of the install base:** none. The only user-visible effect is that an explicitly-configured `backup.includeFiles` will union with defaults instead of replacing them. No agent today has such configuration.
- **External systems:** none. Does not touch Telegram, Slack, GitHub, Cloudflare, git-sync, or any external API.
- **Persistent state:**
    - `BackupManager.DEFAULT_CONFIG.includeFiles` — unchanged.
    - Existing snapshots on disk — unchanged.
    - Future snapshots — include defaults plus any user-configured additions. No path is lost; at most new paths are added.
    - `config.json` — `applyDefaults` will add `backup: { includeFiles: [] }` on next migrator run for any agent that doesn't already have it. Idempotent (rerun → no-op).
- **API surface:** `InstarConfig.backup` is newly typed as an optional field. The existing exported types in `src/index.ts` already re-export `BackupConfig`, so the types are visible to downstream consumers. No breaking change — new optional field.
- **Timing:** none. Constructor path is identical length; the `Array.from(new Set(...))` is O(n) where n is the small merged list (typically < 20 entries).

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change. `git revert` the commit and ship as next patch. Specifics:

- `BackupManager` constructor reverts to spread-replace semantics; no data needs migrating.
- `ConfigDefaults` loses the `backup: { includeFiles: [] }` key. Existing agents that have already migrated and picked up that key will retain it in their `config.json` (harmless — an empty-array `includeFiles` under `backup` that no code reads does nothing). `applyDefaults` never removes keys, so the reverted default doesn't erase it; the key just sits unused until the next roll-forward.
- The six production call-sites revert to passing no second arg; no runtime change observable to anyone who hasn't set `config.backup`.
- The test file reverts to the old "uses custom includeFiles" expectation.

No user-visible regression during rollback window — prior behavior was "no one passes config.backup anyway" so reverting is structurally inert. Estimated rollback effort: one commit revert, one patch release. Zero operational complexity.

---

## Conclusion

This commit delivers the source-side plumbing required before the forthcoming `migrateBackupManifest()` step (Phase A commit 4) can write to `config.backup.includeFiles` with confidence that (a) the path exists at the config layer, (b) `BackupManager` reads it, (c) user additions union with defaults rather than replacing them, and (d) the six production entry points pass the config through. The only semantic change is replace → union on `BackupConfig.includeFiles`, which is a refinement (users can extend, not truncate). No decision points added. No external surface changes. Rollback cost is zero.

Clear to ship pending second-pass review per `/instar-dev` Phase 5 requirement — multiple source files touched, including routes.ts (high-risk-surface module).

---

## Second-pass review (if required)

**Reviewer:** independent subagent (general-purpose agent, fresh context)
**Independent read of the artifact: concur**

Independent checks performed:

- **Merge order correctness** (`BackupManager.ts` constructor lines 83-106): `{ ...DEFAULT_CONFIG, ...config, includeFiles: mergedIncludes }` — `includeFiles` override sits AFTER `...config`, so the pre-computed set-union is the final value. Verified the spread can't silently overwrite it.
- **`applyDefaults` array-opacity** (`ConfigDefaults.ts` lines 180-205): the inner `merge` function's `Array.isArray(target[key])` / `Array.isArray(source[key])` guards skip recursion on arrays, and the `if (!(key in target))` branch adds missing keys whole. Confirmed: user entries in an existing `backup.includeFiles` array are preserved across migrator runs.
- **Blocked-files cohort compatibility** (`backup-manager.test.ts` tests at lines 125/139/153/173/189): assertions are `not.toContain` and `!files.some(startsWith(...))` on blocked items plus `toContain('AGENT.md')`. None preclude defaults being present — union-safe. No breakage.
- **Signal-vs-authority**: diff contains zero branches/classifiers/block-or-allow decisions. Purely plumbing and one merge-algebra change. No decision point added.
- **Type-safety**: `InstarConfig.backup?: Partial<BackupConfig>` → `BackupManager(stateDir, Partial<BackupConfig>?)`. `Partial<Partial<X>>` collapses to `Partial<X>`. `npx tsc --noEmit` clean.
- **Rollback**: reverting leaves an orphan `config.backup.includeFiles: []` in already-migrated agents' `config.json` — harmless; reverted code ignores it. `applyDefaults` never removes keys. Matches artifact's claim.
- **Test run**: `npx vitest run tests/unit/backup-manager.test.ts tests/unit/BackupManager-sharedState.test.ts` → 47 passed (44 + 3), ~1s.

Sign-off: no concerns raised. Merge semantics are order-correct, the union + dedup primitive is appropriate, all six production call-sites are wired consistently, and the artifact's claims match the diff. Clear to ship.

---

## Evidence pointers

- BackupManager source diff: `src/core/BackupManager.ts` — constructor lines 83-107 (post-edit) add the union merge.
- Type change: `src/core/types.ts` — `BackupConfig.includeFiles` JSDoc expanded; `InstarConfig.backup?: Partial<BackupConfig>` added inside the interface (final optional field).
- Config defaults: `src/config/ConfigDefaults.ts` — `SHARED_DEFAULTS.backup` added after `threadline` block.
- Call-sites updated: `src/server/routes.ts:957`, `:967`, `:1004`, and `src/commands/backup.ts:26`, `:39`, `:64`.
- Tests:
    - Updated: `tests/unit/backup-manager.test.ts` "unions custom includeFiles with defaults (never replaces)".
    - New: `tests/unit/backup-manager.test.ts` "missing config.backup does not crash (defaults only)".
    - New: `tests/unit/backup-manager.test.ts` "dedupes entries present in both defaults and user config".
- Test run: `npx vitest run tests/unit/backup-manager.test.ts tests/unit/BackupManager-sharedState.test.ts` — 47 tests pass.
- Adjacent test sweep: `npx vitest run tests/unit/ConfigDefaults.test.ts tests/unit/Config.test.ts tests/unit/config-loadconfig.test.ts tests/unit/init-external-operations.test.ts` — 37 tests pass.
- Type check: `npx tsc --noEmit` — clean.
