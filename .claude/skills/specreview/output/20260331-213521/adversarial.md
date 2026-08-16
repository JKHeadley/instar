# Adversarial Review: Unified Config Defaults System

**Reviewer role**: Adversarial — edge cases, failure modes, and what breaks under pressure  
**Spec**: config-defaults-spec.md  
**Date**: 2026-03-31

---

## Approval Status

**NOT APPROVED as written.** The core idea is sound, but the spec has critical gaps that will cause real incidents at scale. Approve after addressing Critical Issues #1 and #3.

---

## Critical Issues

### 1. No rollback capability on failed migration

The spec describes `applyDefaults()` as patching config in-place, but there is no mention of a backup, dry-run preview, or rollback path. If a deep merge introduces a structural error — malformed JSON, a null where an object is expected, a corrupted nested key — the agent's server will fail to start on next launch with no recovery path except manual file editing.

**Failure scenario**: The `applyDefaults` function merges `CONFIG_DEFAULTS.monitoring` into a config where `monitoring` is currently `null` or a boolean (a field that was previously a toggle). The merge produces invalid output. The agent's server crashes silently on next boot. On 50+ agents this is a mass incident.

**Minimum required fix**: Write `config.json.bak` before any migration. Log the backup path. If migration throws, restore from backup automatically. The spec must specify this.

---

### 2. Wrong defaults applied silently across all agents

The spec acknowledges that managed-project vs standalone agents have different defaults (e.g., `quotaTracking: false` vs `true`) but proposes a single flat `CONFIG_DEFAULTS` object. This means the migrator has no way to know which default set applies to a given agent.

**Failure scenario**: A standalone agent was initialized with `quotaTracking: true`. The unified migrator sees `CONFIG_DEFAULTS.monitoring.quotaTracking = false` (the managed-project default). The spec's "only add missing keys" rule protects *existing* values — but what if the key is already `false` for a managed agent that had it correctly defaulted? The problem is deeper: you cannot know whether a `false` value was set intentionally or was a stale default that should now be `true`.

**Secondary failure**: A future developer changes a default in `CONFIG_DEFAULTS` to fix a new-agent bug. The migrator does not re-apply it to existing agents (by design — "never overwrite"). So old agents continue running with the old wrong value indefinitely. There is no mechanism to propagate a *correction* to a default.

**Minimum required fix**: Either (a) define two named default sets (`MANAGED_DEFAULTS`, `STANDALONE_DEFAULTS`) and record agent type in config at init time, or (b) add a versioned migrations list (see Issue #6) that can force-correct specific fields when a default was wrong.

---

### 3. Race condition: PostUpdateMigrator vs. server startup

The spec states the migrator "runs after every npm update via a post-install hook." The server also reads `config.json` at startup. If the post-install hook and the server start race — which is plausible in any process manager, Docker entrypoint, or `instar update && instar server restart` pipeline — the server may read a partially-written config.

**Failure scenario**: `applyDefaults` is mid-write to `config.json` (buffered I/O, not atomic). The server process starts and reads the file. It sees truncated JSON. Server crashes with a parse error. The migration write completes. On next restart the config is fine — but the crash may have lost in-flight state or triggered an alert.

**Minimum required fix**: Write to `config.json.tmp`, then `fs.renameSync()` to `config.json`. Rename is atomic on POSIX filesystems. The spec must mandate atomic writes.

---

### 4. CONFIG_DEFAULTS staleness has no detection mechanism

The spec does not define when or how `CONFIG_DEFAULTS` gets updated, who is responsible, or what happens when a default is simply wrong for a year. With 50+ agents, a stale default that was never corrected becomes ambient debt that silently misconfigures every new agent.

**Example**: `threadline.visibility = 'public'` is the default today. In six months, a security incident means all new agents should default to `'private'`. A developer changes the init path but forgets `ConfigDefaults.ts`. New agents get `'private'`. Existing agents, protected by "never overwrite," retain `'public'`. No alert fires. No audit catches it.

**This is not hypothetical** — the spec's stated motivation is exactly this: PromptGate was missing because someone updated one code path and not the other. The proposed fix has the same single-file update failure mode, just in a new file.

**Recommendation**: Add a CI test that generates a config from `init.ts` and asserts it deep-equals `applyDefaults({}, CONFIG_DEFAULTS)`. This catches the "updated one place, not the other" failure mode the spec is trying to solve.

---

### 5. Intentional opt-out is indistinguishable from missing config

The spec acknowledges this in Design Question #2 but does not answer it. An agent that explicitly disabled `promptGate.enabled = false` has the same config shape as an agent that never had `promptGate` migrated and got `enabled: false` by default. The migrator cannot tell the difference.

**Failure scenario**: Agent "harbor" was deployed with `promptGate.enabled: false` intentionally (it runs in a fully automated pipeline with no human review). An instar update adds new subfields to `promptGate`. The migrator runs, adds the new fields using defaults, and one of those new fields re-activates a promptGate behavior. The agent's automation pipeline stalls waiting for approvals that never come.

**More subtle failure**: The spec says the migrator adds fields "if missing." But what if the feature didn't exist when the agent was created, and the field is absent — not intentionally set to false, but just not there? The migrator correctly adds `promptGate`. But the agent owner's intent was "don't gate me." Migrating in `enabled: true` violates their expectation even though the migrator followed the spec correctly.

**Minimum required fix**: Add an explicit opt-out mechanism: `"_instar_noMigrate": ["promptGate", "externalOperations"]` in config. Fields in this list are never touched by the migrator regardless of missing keys.

---

### 6. No versioning — no idempotency proof

The spec describes `applyDefaults` as "only add missing keys" — which is idempotent in theory. But there is no version tracking. The system cannot answer:
- Which defaults have been applied to this agent?
- Was this agent migrated before or after the `promptGate` default changed?
- Did the migrator run on this config, or did the user manually set these values?

Without versioning, there is no audit trail and no way to apply a corrective migration (overwrite a wrong default) selectively. Every future "we need to fix a bad default" requires a manual intervention on every agent, exactly the problem this spec is trying to solve.

**Recommendation**: Add a `_instar_migrations: string[]` field to config (e.g., `["defaults-v1", "defaults-v2"]`). Each migration run appends its version. Corrections to wrong defaults ship as new named migrations that can check the version list and apply a targeted overwrite.

---

### 7. Multi-machine git sync creates a new conflict surface

The spec does not mention Instar's git sync capability. Agents that run on multiple machines sync `config.json` via git. The PostUpdateMigrator runs independently on each machine after each `npm update`. If two machines run the migrator simultaneously — or if one machine has a newer instar version than another — they will both modify `config.json` and attempt to push.

**Failure scenarios**:
- Machine A runs migrator, adds `promptGate`, commits. Machine B runs migrator concurrently, adds `promptGate` with slightly different timestamps or generated values, commits. Git conflict on next sync.
- Machine A is on instar v0.26, Machine B is on v0.25. Machine A's migrator adds new fields from v0.26 defaults. Machine B's migrator, running the old code, sees the new fields and either ignores them (fine) or errors on unknown structure (not fine).
- A user manually edits `config.json` on Machine B. Migrator runs on Machine A. Both write config. Git sync creates a merge conflict in a JSON file — which git will not auto-resolve cleanly.

**Minimum required fix**: The migrator should check if the config was modified more recently than the last known sync (via a lock or timestamp). Alternatively, migrations should be idempotent and commutative so that concurrent application of the same migration from two machines produces an identical result. This needs to be stated explicitly in the spec, not left as an implementation detail.

---

## Recommendations

**High priority (must fix before implementation):**
1. Mandate atomic config writes (`tmp` + `rename`)
2. Mandate pre-migration backup (`config.json.bak`)
3. Add `_instar_noMigrate` opt-out list to the spec
4. Define separate default sets per agent type (`MANAGED_DEFAULTS` / `STANDALONE_DEFAULTS`)

**Medium priority (should fix before rollout):**
5. Add `_instar_migrations: string[]` versioning to enable corrective migrations
6. Add a CI test: `init output === applyDefaults({}, CONFIG_DEFAULTS)` (closes the two-place-update failure mode)
7. Explicitly address multi-machine git sync behavior in the spec

**Low priority (good practice):**
8. Add a lint rule or TypeScript test that warns when `CONFIG_DEFAULTS` is missing keys that appear in init's generated config
9. Document how to *deprecate* a config field (spec currently only covers adding fields)
10. Define behavior when `applyDefaults` encounters an unexpected type mismatch (e.g., field exists but is wrong type)

---

## Score: 4/10

The spec correctly identifies the root cause (two-place updates with no enforcement) and the right solution direction (single source of truth). But it leaves too many critical failure modes unaddressed. The "never overwrite" rule is the right instinct but is underspecified in every dangerous edge case: wrong defaults, intentional opt-outs, type mismatches, concurrent writes, and cross-version migrations. At 50+ agents, any one of these failure modes is a multi-agent incident. Fix the atomicity and opt-out gaps at minimum before implementation.
