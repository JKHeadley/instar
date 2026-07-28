# Side-effects review — ABI-aware node selection (durable SQLite-bane fix)

**Scope:** Node-binary selection (`pickDurableNodePath` / `ensureStableNodeSymlink` / boot-wrapper `selfHealNodeSymlink`) now considers native-module ABI compatibility, not just path durability. Stops the recurring failure where a Node major bump (via `brew upgrade`) leaves `better-sqlite3` unable to load and silently degrades the SQLite layer.

**Files touched:**
- `src/commands/setup.ts` — new `nodeCanLoadNativeModule()` (empirical ABI check via `execFileSync require()`); extracted pure `selectDurableNode()` (exported, testable); `pickDurableNodePath()` now wraps it with IO predicates; `ensureStableNodeSymlink()` passes the shadow-install `better-sqlite3` binary as the ABI anchor and re-points when the current node can't load it; boot-wrapper `selfHealNodeSymlink` template gains an ABI-load check in its "leave it alone" branch.
- `src/core/PostUpdateMigrator.ts` — new `migrateBootWrapperAbiCheck()` regenerates `instar-boot.cjs` for existing `.cjs` agents lacking the ABI marker; import of `installBootWrapper`.
- `tests/unit/durable-node-selection.test.ts` (11), `tests/unit/PostUpdateMigrator-bootWrapperAbiCheck.test.ts` (3).

**Under-block:** None. When no native module exists (fresh install before shadow-install), the ABI predicate is absent and behavior is identical to before (durability-only). When all candidates are compatible, the same durable path is chosen as before.

**Over-block:** A previously-selected stable node that is ABI-incompatible will now be passed over in favor of a compatible version-specific node. This is the intended correction. The only "cost" is preferring a version-specific path (which can disappear if that Node version is uninstalled) — but a broken native-module layer is the worse failure, and the boot-wrapper self-heal re-resolves candidates if the version-specific path later disappears.

**Level-of-abstraction fit:** The pure selection logic (`selectDurableNode`) is separated from IO (existence + ABI checks injected as predicates), making it unit-testable without spawning real node processes. The IO wrapper (`pickDurableNodePath`) and the two call sites (`ensureStableNodeSymlink`, boot-wrapper) consume it.

**Signal vs authority:** Candidate node paths + their ABI-load results are SIGNALS; `selectDurableNode` is the AUTHORITY that resolves the final pick. No new authority introduced; the durability heuristic is unchanged, only gated by ABI compatibility first.

**Interactions:**
- `NativeModuleHealer` / `ServerSupervisor` preflight rebuild paths are unaffected — they still attempt a rebuild when the module fails to load. This fix is upstream of them: by selecting a compatible node, the rebuild path is needed far less often. When `better-sqlite3` genuinely can't be satisfied by any available node, both layers degrade gracefully (rebuild fails → degradation surfaced; selection falls back to durability-only).
- `resolveNodeBinary` (heal-execpath staleness) is orthogonal — it finds *a* working node when `process.execPath` disappears; this fix governs *which* node the durable symlink targets.
- The boot-wrapper change only adds an ABI check to an existing branch; the candidate-search logic below it (which already had ABI awareness) is unchanged.

**External surfaces:** None. No new API, config field, or CLI flag. `selectDurableNode` is newly exported for testing but is internal tooling.

**Migration parity:** Covered. `ensureStableNodeSymlink` runs on every setup/update (existing agents get ABI-aware selection on next update). `migrateBootWrapperAbiCheck` regenerates the boot wrapper for existing `.cjs` agents that the `.js→.cjs` migration skipped. Both idempotent.

**Rollback cost:** Moderate — revert the setup.ts changes (selection + symlink + boot-wrapper template) and remove the migration. No persisted-state migration to unwind; the node symlink simply re-resolves on next run.

**Tests:**
- 14 new unit tests (11 selection + 3 migration), all pass. tsc clean. `setup.js` loads without syntax error (boot-wrapper template validity).
- Empirical: codey pinned Node 25 → 22; SQLite-backed `/tokens/summary` returns real data; `sqlite-runtime-broken` degradation cleared.

**Decision-point inventory:**
1. **Empirical ABI check (spawn `require()`) vs hardcoded version table.** Spawning is authoritative — it asks the actual binary to load the actual module, so it tracks whatever majors `better-sqlite3` supports without a maintenance burden when that set changes. Cost: a ~10s timeout per candidate during selection (rare path).
2. **Prefer compatible-version-specific over incompatible-stable.** A working SQLite layer outranks symlink durability; the boot-wrapper re-heal covers the version-specific-disappears case.
3. **Fall back to durability-only when nothing compatible.** Better a working `node --version` (server boots, degrades gracefully) than no node at all (server can't start).
4. **Separate migration for `.cjs` agents.** The existing `.js→.cjs` migration intentionally skips `.cjs` agents; a dedicated marker-sniffing migration is the only way to reach them per the Migration Parity Standard.
