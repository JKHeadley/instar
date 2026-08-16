## DX Review: Unified Config Defaults System

**Approval Status: CONDITIONAL APPROVAL**

The core idea is sound and fixes a real recurring pain point. Four issues need resolution before implementation: the dual-defaults problem, the migration-only boundary, the traceability gap, and the error handling spec gap.

---

### Critical Issues

**1. The dual-defaults problem is unresolved**

The spec acknowledges `quotaTracking` differs between managed-project (`false`) and standalone (`true`) but doesn't resolve it. `CONFIG_DEFAULTS` has a single value. This means new standalone agents get the wrong default silently, OR the developer manually overrides it post-spread — reintroducing the exact two-places problem the spec is solving.

This is presented as a "design question" but it's a blocking design decision. Two viable options: (a) `CONFIG_DEFAULTS` as a base with `STANDALONE_OVERRIDES` / `MANAGED_OVERRIDES` merged on top, or (b) `CONFIG_DEFAULTS` covers only fields identical across all agent types; type-specific fields stay in init.ts explicitly. Either works, but the choice must be documented.

**2. The migration-only boundary has no enforcement**

The spec leaves as an open question which fields should only exist for new agents. This is the most dangerous gap. If a developer adds a field to `CONFIG_DEFAULTS` not knowing it shouldn't migrate, it silently pushes to all existing agents on next update — potentially with wrong values derived from init-time context (generated URLs, machine-specific paths, pairing tokens).

Needed: either a `CONFIG_INIT_ONLY` export, or a documented convention that PostUpdateMigrator uses a `MIGRATION_DEFAULTS` subset, not the full object. Without this, "add once" is a false promise — developers still need to know which target to add to.

**3. No traceability when a config value is wrong**

When a value is unexpected, there's no way to determine whether it came from init.ts, a PostUpdateMigrator run (which version?), a manual edit, or a LiveConfig change. A low-cost fix: the migrator appends to a `_migrations` log in config.json listing `{ version, timestamp, fieldsAdded[] }`. Without this, debugging is always guesswork.

**4. `applyDefaults` error handling is unspecified**

The signature is shown but behavior on edge cases is undefined:
- Type mismatch: existing config has `promptGate: true` (boolean), defaults expect an object. Overwrite? Throw? Skip?
- Null vs missing: is `promptGate: null` "user explicitly disabled" or "corrupted config"?
- Arrays: does deep merge union, replace, or leave existing arrays alone?

The `changes` return value should also report fields that were skipped due to type conflict.

---

### Recommendations

**Developer guidance: add a comment block to ConfigDefaults.ts** defining exactly what belongs there (fields safe for all agent types, not runtime-generated, not type-specific). This is the answer to "how does a developer know what to put here." Without it, the file is a footgun.

**User surprise: migrations should be visible.** The migrator runs silently. After this change, an update could add multiple top-level config fields. Users who version-control config.json will see unexplained diffs. Recommended: log a human-readable summary to the server log and optionally the attention queue listing which fields were added.

**Rollback story is missing.** The answer is simple — set the field to your desired value, `applyDefaults` won't overwrite existing keys — but it needs to be documented. The one gotcha: deleting a field causes it to be re-added on next update. Users need to know: set it, don't delete it.

**CI test: not optional.** The spec correctly identifies this as needed. A test asserting init.ts output is a superset of `CONFIG_DEFAULTS` would have caught the PromptGate regression that motivated this entire spec. Should be mandatory.

**LiveConfig interaction needs a definitive answer.** If LiveConfig doesn't write back to disk, the migrator could overwrite a runtime setting on next update. This needs verification, not assumption.

---

### Score: 6.5 / 10

The spec correctly identifies the problem, proposes a clean architectural fix, and frames the right design questions. The deduction is for leaving four consequential decisions unresolved. The implementation is not ready to start until the dual-defaults split, migration boundary, audit trail, and type-mismatch behavior are decided. The bones are good; the gaps are fillable.
