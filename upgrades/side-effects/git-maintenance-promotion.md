# Side-Effects Review — Git Maintenance Promotion

**Version / slug:** `git-maintenance-promotion`
**Date:** `2026-06-06`
**Author:** `Instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change promotes Codey's proven git hygiene maintenance from a local dogfood implementation into the shared Instar distribution. It ships two framework-neutral scripts under `.instar/scripts`, installs them during fresh init and post-update migration, adds a built-in AgentMD `git-maintenance` job, updates the infrastructure overseer prompt to watch that job, tracks the new templates in the built-in manifest, and adds regression tests for fresh install and upgrade-time script deployment.

## Decision-point inventory

- `git-maintenance.mjs --apply` — add — index-only repair path that removes already-ignored files from git tracking while leaving files on disk.
- `git-maintenance` built-in job — add — scheduled audit signal; default job instructions do not apply repairs without operator/scoped-task authorization.
- `PostUpdateMigrator.migrateScripts` — modify — deploys generated git-maintenance scripts to existing agents on package upgrade.
- Built-in manifest generator — modify — records built-in AgentMD job templates as packaged artifacts.

---

## 1. Over-block

No user-facing block/allow surface is added. The scheduled job runs audit mode with `--no-fail`; it reports findings but does not block work. The only repair mode is explicit `--apply`, and it only calls `git rm --cached` for files already matched by ignore rules. A legitimate source file that is ignored by mistake could be removed from the index if an operator explicitly runs apply, so the job text keeps apply behind explicit authorization.

---

## 2. Under-block

The classifier is intentionally conservative. It may miss sensitive content whose path does not include an obvious credential/local-state marker, and it does not inspect file contents. It also does not auto-fix unignored local-only paths, because adding ignore rules requires repo-specific judgment. Those are acceptable misses for a maintenance signal: the job is designed to surface hygiene drift, not to be a comprehensive secret scanner.

---

## 3. Level-of-abstraction fit

The classifier and maintenance script are the right low-level layer for deterministic git state facts: dirty paths, ignored tracked files, and sensitive-looking tracked paths. They are not a smart authority. The built-in job is the right higher-level surface for periodic review and operator-visible summaries. Post-update migration is the right distribution layer for existing agents because it already refreshes generated scripts.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The default scheduled behavior is audit-only and non-blocking. The brittle classifier produces maintenance signals and durable reports. It does not own push/commit authority and does not automatically change repository state. The explicit apply mode is a bounded operator/tool action, not a hidden autonomous authority.

---

## 5. Interactions

- **Shadowing:** The job does not replace git-sync, dangerous-command guards, pre-commit hooks, or secret scanning. It gives those workflows cleaner inputs by identifying local-only drift earlier.
- **Double-fire:** The AgentMD job may run near git-sync, but it defaults to audit mode and does not mutate state, so there is no competing write path.
- **Races:** Explicit apply mode stages index removals and should not be run concurrently with another staging operation. The scheduled job does not use apply.
- **Feedback loops:** Reports are written under `.instar/state`, which is already local runtime state. The source repo also ignores `.instar/audit` to avoid test/runtime audit output becoming dirty source state.

---

## 6. External surfaces

New and upgraded agents receive two executable scripts in `.instar/scripts` and a built-in scheduled job. Operators may see a new infrastructure job entry and occasional plain-language findings if a repository has tracked ignored files or suspicious local config. No external network services are called. Persistent state is limited to `.instar/state/git-maintenance-report.{json,md}`. The built-in manifest changes package metadata only.

---

## 7. Rollback cost

Rollback is a normal hot-fix release: remove the built-in job template, stop installing the scripts, and ship the next package. Existing agents would retain previously installed scripts until a later cleanup migration, but those scripts are inert unless invoked and the scheduled job can be retired by removing the built-in template. Reports under `.instar/state` are local runtime artifacts and need no migration.

---

## Conclusion

The change is clear to ship. The design keeps brittle detection in an advisory/reporting role, requires explicit authorization for the only mutating repair, and is covered by fresh-install, migrator, manifest, packaging, default-job, lint, and direct script validation.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

The change adds an infrastructure maintenance signal and generated scripts, but it does not add a blocking gate, session lifecycle control, messaging decision, coherence authority, or trust decision.

---

## Evidence pointers

- `npm run lint -- --pretty false`
- `npm test -- --run tests/unit/PostUpdateMigrator-gitMaintenanceScripts.test.ts tests/integration/fresh-install.test.ts tests/unit/builtin-manifest.test.ts tests/integration/npm-pack-templates-smoke.test.ts tests/unit/default-jobs-valid.test.ts`
- `node --check src/templates/scripts/git-hygiene-classify.mjs && node --check src/templates/scripts/git-maintenance.mjs`
- `node src/templates/scripts/git-maintenance.mjs --no-fail --out-dir /tmp/instar-git-maint-final3`
