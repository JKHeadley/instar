# Unified Config Defaults System — Specification

## Problem Statement

New config fields get added to `init.ts` (for new agents) but NOT to `PostUpdateMigrator.ts` (for existing agents), causing existing agents to silently miss features. This has happened repeatedly:
- PromptGate was missing for all agents except Echo (manually configured)
- Every new config addition requires changes in TWO places with no enforcement

## Current Architecture

**init.ts** — Creates config.json from scratch for new agents. Has 2 code paths:
1. Managed-project config (line ~227) — full config with monitoring, sessions, scheduler, etc.
2. Standalone-agent config (line ~875) — similar but with different defaults (e.g., quotaTracking: true vs false)

**PostUpdateMigrator.ts** — Runs after every npm update. Has a `migrateConfig()` method that patches existing config.json with missing fields. Currently handles:
- dashboardPin (auto-generate if missing)
- externalOperations (add defaults)
- threadline (add defaults)  
- promptGate (just added in v0.25.9)

Each migration is a manual if-block that checks for the field and adds it if missing.

**Key constraint: Never overwrite user customization.** If a user set `promptGate.autoApprove.planApproval: true`, the migrator must NOT reset it to `false`.

## Proposed Design

### ConfigDefaults.ts

```typescript
export const CONFIG_DEFAULTS = {
  monitoring: {
    quotaTracking: false,
    memoryMonitoring: true,
    healthCheckIntervalMs: 30000,
    promptGate: {
      enabled: true,
      autoApprove: { enabled: true, fileCreation: true, fileEdits: true, planApproval: false },
      dryRun: false,
    },
  },
  externalOperations: {
    enabled: true,
    sentinel: { enabled: true },
    trust: { floor: 'supervised', autoElevateEnabled: false, elevationThreshold: 10 },
  },
  threadline: {
    relayEnabled: false,
    visibility: 'public',
    capabilities: ['chat'],
  },
};

// Deep merge: only add missing keys, never overwrite existing values
export function applyDefaults(config: Record<string, unknown>, defaults: Record<string, unknown>): { patched: boolean; changes: string[] };
```

### Usage in init.ts
```typescript
import { CONFIG_DEFAULTS } from '../config/ConfigDefaults.js';
const config = { ...CONFIG_DEFAULTS, agentType: 'standalone', ... };
```

### Usage in PostUpdateMigrator.ts
```typescript
import { CONFIG_DEFAULTS, applyDefaults } from '../config/ConfigDefaults.js';
const { patched, changes } = applyDefaults(existingConfig, CONFIG_DEFAULTS);
```

## Design Questions

1. Should there be DIFFERENT defaults for managed-project vs standalone-agent? (Currently quotaTracking differs)
2. How do we handle fields that should ONLY exist for new agents but NOT be migrated to existing ones?
3. Should the deep merge be recursive (merge nested objects) or shallow (replace at top level)?
4. What about config fields that depend on runtime context (e.g., port, authToken, paths)?
5. Should we add a CI test that verifies init produces a superset of CONFIG_DEFAULTS?
6. What about removed/deprecated config fields — should the migrator clean those up?
7. How does this interact with LiveConfig (runtime config changes)?

## Context

- Instar is a framework for persistent AI agents (Claude Code based)
- Agents run on individual machines with local config.json files
- Config is read at server startup and some fields can be changed at runtime via LiveConfig
- The PostUpdateMigrator runs automatically after npm updates via a post-install hook
- There are currently ~50+ config fields across monitoring, sessions, scheduler, messaging, etc.
- Some config fields are generated at runtime (authToken, port, paths) and should NOT be in defaults
- Some config fields differ between agent types (managed-project vs standalone)
