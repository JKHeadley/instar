# Architecture Review: Unified Config Defaults System

**Approval Status: CONDITIONAL APPROVE**
**Score: 7/10**

## Critical Issues

**1. Array Handling Undefined** — Arrays in defaults (capabilities: ['chat']) need explicit semantics. Must be replace-if-absent only to maintain idempotency.

**2. Agent-Type Defaults Collapsed** — quotaTracking differs per type. Need split: CONFIG_DEFAULTS_SHARED + MANAGED/STANDALONE overrides.

**3. LiveConfig Cache Invalidation** — Migration writes to disk but running server's LiveConfig polls mtime with 5s window. Need force-refresh after migration.

## Recommendations
- Runtime-generated fields (port, authToken, paths) must NEVER appear in CONFIG_DEFAULTS
- MIGRATION_EXCLUDED_PATHS Set for new-agent-only fields
- Deprecated field cleanup as separate versioned method
- CI tests: superset coverage + idempotency (both block merges)
- Guard non-object parent nodes in deep merge

## Blocking Items
- Array handling specified as replace-if-absent
- Split MANAGED/STANDALONE defaults
- Add agentType to MigratorConfig
- CI superset + idempotency tests
- Guard non-object parent nodes
