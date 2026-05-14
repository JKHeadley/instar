# Side-Effects Review — F-7: PostUpdateMigrator atomic-step + announceOnce primitives (Tier-2)

**Version / slug:** `f7-post-update-migrator-atomic-step`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Ships F-7 from the Self-Healing Remediator v2 spec (`docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §R1 Upgrade invariants + §A35 backup/sync wiring + §A50 hook-shape corrections + §A57 Tier-2 phase manifest).

Two new primitives plus the A35 hook-shape changes:

1. **`MigratorStepEngine`** — atomic, idempotent, run-once-per-version migration steps. Steps are registered by name + version. The engine writes a ledger at `<stateDir>/migrator-steps-completed.json` keyed by `<version>:<step-name>`. A step failure records `outcome: 'failed'` and does NOT roll back prior steps or block subsequent steps — each step is self-contained.

2. **`AnnouncementManager`** — `announceOnce(id, message, channel)` primitive. Emits a message exactly once per id, then never again. Ledger at `<stateDir>/announcements-shown.json`. Used for surfacing migration completions and structural-change notices without spamming the user across restarts.

3. **A35 hook-shape — `GitStateManager.DEFAULT_GITIGNORE` extension.** Const literal now contains five remediation runtime path globs (`remediation/system-reviewer-state-*.json`, `remediation/inbox-*.jsonl`, `remediation/audit-projection-*.jsonl`, `remediation/cross-process-attempts-*.jsonl`, `remediation/llm-raw-*.jsonl`). Exported as `REMEDIATION_GITIGNORE_ENTRIES` for the F-7 atomic step to use as the source-of-truth list.

4. **A35 hook-shape — `BackupManager` exclusion list with feature-flag gate.** New const `REMEDIATION_EXCLUDED_PATH_PREFIXES` (exported) — the five remediation path prefixes. New optional constructor arg `isRemediationEnabled?: () => boolean` parallels the existing `isIntegratedBeingEnabled` gate. When the gate is ON, the prefixes drop any user-added `includeFiles` entry that begins with a remediation prefix. When OFF (or absent), the prefixes are inactive — strictly additive, no back-compat break.

Files touched:
- `src/core/MigratorStepEngine.ts` (add)
- `src/core/PostUpdateMigrator.ts` (modify — add `registerStep` + `runPendingSteps` + lazy engine field; existing constructor + all 15 existing migration methods unchanged)
- `src/core/GitStateManager.ts` (modify — extend `DEFAULT_GITIGNORE` const literal; export `REMEDIATION_GITIGNORE_ENTRIES`)
- `src/core/BackupManager.ts` (modify — add `REMEDIATION_EXCLUDED_PATH_PREFIXES` const + export; add 5th optional constructor arg `isRemediationEnabled`; gate logic in `resolveIncludedFiles`)
- `tests/unit/PostUpdateMigrator-atomicStep.test.ts` (add — 8 cases)
- `tests/unit/AnnouncementManager.test.ts` (add — 5 cases)
- `tests/unit/PostUpdateMigrator-a35-remediationPaths.test.ts` (add — 5 cases)
- `upgrades/NEXT.md` (modify — preserves all existing entries; adds A35 + announceOnce entries)

## Decision-point inventory

- `PostUpdateMigrator.registerStep()` — **add** — delegates to lazy `MigratorStepEngine`. Existing 15 `migrate*` methods + `migrate()` orchestrator untouched.
- `PostUpdateMigrator.runPendingSteps()` — **add** — async; returns `{ steps: [{name, outcome, details}] }`. Never throws.
- `MigratorStepEngine.registerStep()` — rejects duplicate names, missing version/run.
- `MigratorStepEngine.runPendingSteps()` — three skip reasons: `already-recorded:<outcome>`, `future-version:<step.version> > <toVersion>`, and explicit `'skipped'` from the step itself. Failed steps record `outcome: 'failed'` and DO NOT retry (operator must clear the ledger entry to retry — surfaces the failure in the report).
- `MigratorStepEngine.writeLedger()` — atomic temp-file → fsync → rename, `0600` perms.
- `AnnouncementManager.announceOnce()` — three-input validation (id, message, channel); records BEFORE sink-invoke so a flaky sink cannot cause duplicate emission. Sink throws are swallowed (ledger entry stands).
- `GitStateManager.DEFAULT_GITIGNORE` const literal — **modify** — append remediation block. Backwards-compatible: previously private const is now exported (no internal call sites broken).
- `BackupManager` constructor — **modify** — append 5th optional argument. All four existing call sites pass ≤4 args and continue to work.
- `BackupManager.resolveIncludedFiles()` — **modify** — adds gated exclusion loop. When gate is OFF (the default — every existing caller), behavior is identical to pre-PR.

No new HTTP routes. No new daemon processes. No new file types beyond two JSON ledgers in `<stateDir>`.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **A future-version step is silently skipped.** Intended. The ledger is NOT written when the step's version > `toVersion`, so the next upgrade boundary that crosses the threshold runs the step.
- **A failed step is NOT auto-retried on the next `runPendingSteps()` invocation.** This could be seen as over-blocking — a transient failure (disk full, network blip) gets recorded as `failed` and stays that way. Trade-off accepted because the alternative (unbounded retry on every update) lets a broken step DoS every release. Operator-facing mitigation: the failed entry surfaces in the migration report; clearing the ledger key allows retry.
- **The `BackupManager` remediation-prefix gate, when ON, drops includeFiles entries whose paths begin with a remediation prefix.** A user who manually adds `.instar/remediation/system-reviewer-state-mine.json` to `config.backup.includeFiles` will see it silently dropped. Mitigated by: (a) the gate defaults to OFF until remediation is enabled; (b) the prefixes are documented in code + spec; (c) this is the explicit spec requirement (A14 "Backed up? no" rows).

No unintended over-blocks.

---

## 2. Under-block

**What failure modes does this still miss?**

- **No cross-machine coordination of step execution.** Two machines updating to the same version in parallel each run their own steps independently. The ledger is per-machine. This is the correct model for per-machine state (gitignore lives in `<stateDir>/.gitignore` which is per-machine via the `.instar` git repo), but a future cross-machine migration would need additional coordination.
- **Step `run()` is not deadline-enforced.** A hung step could block subsequent steps. The engine relies on step authors to be well-behaved. Real-world steps are file I/O against `<stateDir>` and complete in <50ms; a step that calls external APIs should add its own timeout. Worst case: the migrator hangs, the next update boundary sees the same situation; the user can `kill` the process and the ledger remains consistent.
- **The `announceOnce` sink does not retry.** If a sink fails (e.g. Telegram offline), the announcement is recorded as shown but never delivered. This is the deliberate signal-vs-authority separation: the brittle sink layer does not have authority over the ledger. A future enhancement could add a separate delivery queue; F-7 keeps the primitive minimal.
- **Ledger corruption is treated as empty.** If `migrator-steps-completed.json` becomes corrupt (truncated, bad JSON), the engine falls back to an empty ledger. This is intentional — the alternative (refuse to migrate) would be worse. Cost: a corrupt ledger causes one round of step re-runs; each step is idempotent by spec.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The two primitives sit at the `src/core/` layer — the same layer as `PostUpdateMigrator`, `GitStateManager`, `BackupManager`. They compose on top of `node:fs` only; no dependency on the Remediator (Tier-2 surfaces will register their own steps via `migrator.registerStep(...)` after import). The A35 const-literal extensions sit where the const lives — `GitStateManager` for the gitignore, `BackupManager` for the exclusion prefixes. No new plugin/register API was introduced per A50's explicit ruling.

The `PostUpdateMigrator` class is the right owner for the public-facing `registerStep`/`runPendingSteps` methods even though the engine logic lives in `MigratorStepEngine` — the existing class is already the documented entry point for "thing that runs on update boundary". Tier-2/Tier-3 surfaces (S-2, S-3) will reach for `PostUpdateMigrator` first.

---

## 4. Signal-vs-authority compliance

The brittle/low-context layers (file I/O ledger reads, sink invocations) are signal layers. The higher-context layer (the `runPendingSteps` orchestrator) is the authority. Specifically:

- A corrupt ledger does NOT block migration — the ledger is treated as a signal ("here's what we believe happened"), and the engine recovers by treating it as empty. Authority over "should this step run" lives in the in-memory step list + the version comparison.
- A failing sink does NOT block `announceOnce` from recording the announcement — sink delivery is signal; the ledger record is authority over "have we already attempted to surface this".
- A failing step does NOT block other steps — the per-step try/catch isolates signals; the engine retains authority over the run sequence.

This matches the §A50 / signal-vs-authority principle in MEMORY.md.

---

## 5. Interactions with existing surfaces

- **`PostUpdateMigrator.migrate()` is untouched.** Existing callers (`src/update/UpdateService.ts`, `src/commands/init.ts`, etc.) continue to work — they call `migrate()` and never touch the new methods.
- **`GitStateManager.init()`** — writes `DEFAULT_GITIGNORE` only when no `.gitignore` exists. Existing repos with `.gitignore` already on disk are unaffected. New repos get the remediation entries pre-included.
- **`BackupManager` callers** — 14 existing call sites pass at most 4 constructor args. The new 5th arg is optional + defaults to no-op behavior. Verified by running the full `backup-manager.test.ts` (44 cases) and `BackupManager-sharedState.test.ts` (3 cases) — all pass unchanged.
- **`upgrades/NEXT.md`** — only appended to (preserving the W-1, F-8, F-3, F-4, F-1..F-2 entries already on main).

---

## 6. Rollback cost

Low. The two new modules (`MigratorStepEngine.ts`, the new methods on `PostUpdateMigrator.ts`) are dormant unless something calls `registerStep` — and nothing calls it in this PR. Tier-2 surfaces will be the first consumers. Reverting requires:

1. `git revert` the PR. No data migration. No format changes. Existing `migrate()` behavior is untouched.
2. If any agent has already created `migrator-steps-completed.json` or `announcements-shown.json` files, they become unused leftovers — no harm. They can be deleted at leisure.

The A35 const-literal changes are inline edits to existing files; revert restores the prior literal. The `BackupManager`'s 5th constructor arg is optional and unused by every current caller, so removing it has zero blast radius.

---

## Tests

- `tests/unit/PostUpdateMigrator-atomicStep.test.ts` — 8 cases covering: step runs once and records completion; step is skipped on subsequent runs; failed step records failure and doesn't block other steps; future-version step skipped without ledger entry; state persists across instances; semver compare correctness.
- `tests/unit/AnnouncementManager.test.ts` — 5 cases covering: first-true / subsequent-false; independent ids; persistence across instances; sink-throw does not cause re-emission; input validation.
- `tests/unit/PostUpdateMigrator-a35-remediationPaths.test.ts` — 5 cases covering: `DEFAULT_GITIGNORE` contains all five remediation entries; `REMEDIATION_EXCLUDED_PATH_PREFIXES` exported correctly; gate ON drops remediation entries; gate OFF preserves them; absent callback = back-compat (gate OFF).

All 18 new tests pass. All 76 pre-existing `PostUpdateMigrator-*` tests pass unchanged. All 47 `BackupManager*` tests pass unchanged. TypeScript clean (`tsc --noEmit`).

---

## Gate trace

- side-effects review: this document
- NEXT.md: amended, preserving every prior entry
- spec citation: `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §R1 + §A35 + §A50 + §A57
- worktree: `/tmp/instar-f7-post-update-migrator` (branch `f7-post-update-migrator`)
- no bypass; no `--no-verify`
