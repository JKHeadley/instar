---
name: capability-parity-renderings-backfill
description: Instar v1.0.11 — PostUpdateMigrator.migrateAsync() iterates parity rule registry on every `instar update` and re-renders canonical skills/hooks/memory into framework-native shapes for enabled frameworks.
metadata:
  type: project
---

# Parity Renderings Backfill (v1.0.11)

On every `instar update`, `PostUpdateMigrator.migrateAsync()` iterates the Layer-3 parity rule registry and re-renders every canonical instance into the framework-native shape for every enabled framework. Existing deployed agents pick up canonical sources automatically on update — no longer dependent on a sentinel scan that isn't wired to boot.

## Mechanics

- **Idempotent** via `_instar_migrations` marker — second run is a no-op.
- **Per-rule policy preserved**:
  - Hook renderings → always-overwrite (Migration Parity §4).
  - Skill / memory renderings → refuse-on-conflict (§5). User-edited renderings captured as skips with operator-action notes.
- **New `migrateAsync()` companion** to `migrate()`. Sync callers keep working; the three production call sites (cli.ts, UpdateChecker.ts, server.ts) now await full migration including parity backfill.
- **Registry-iteration pattern** means future Agent/Tool parity rules pick up the backfill automatically when added (only skill/hook/memory exist in v0.1).

## How to apply

- When users add a canonical hook / skill / memory and then run `instar update`, the framework-native rendering appears automatically. No manual sentinel scan needed.
- When debugging missing renderings post-update: check the `_instar_migrations` marker and the per-rule skip list (user-edited files surface as operator-actionable skips).
- Tests for this surface live at `tests/unit/PostUpdateMigrator-parityRenderings.test.ts` — registry iteration, framework filtering, refuse-on-conflict, error capture, idempotency, empty-source new-agent path, continue-past-rule-failure, missing-config skip, migrateAsync wrapping contract.

## Deferred follow-ups

- Agent and Tool parity rules not yet implemented — backfill covers them automatically once they land.
- Testing Integrity Tier-3 (E2E lifecycle) tests for primitive specs and conversational-action v0.2 on-demand wiring remain next.

Related: [[capability-hook-parity-rule]]
