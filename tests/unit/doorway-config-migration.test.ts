// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 unit tests for the `maintenance.doorwayScan` config-knob seed
 * (docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md §D6 / §Migration Parity).
 *
 * The load-bearing invariant (the round-2/round-5 bug the spec calls out): the migration seeds
 * EVERY field EXCEPT `enabled`. A seeded `false` would make the D6 deny-wins predicate
 * (`config.enabled !== false`) treat it as a permanent block and the scan would NEVER run even
 * after the job manifest is enabled. So `enabled` must stay ABSENT unless the operator sets it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getInitDefaults, getMigrationDefaults, applyDefaults } from '../../src/config/ConfigDefaults.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('maintenance.doorwayScan config seed (D6 fail-closed defaults, enabled-stays-absent)', () => {
  it('getInitDefaults + getMigrationDefaults seed every field EXCEPT enabled (fail-closed)', () => {
    for (const defs of [getInitDefaults('managed-project'), getMigrationDefaults('managed-project')]) {
      const ds = (defs.maintenance as { doorwayScan?: Record<string, unknown> } | undefined)?.doorwayScan;
      expect(ds).toBeDefined();
      expect(ds!.scope).toBe('free-probes');
      expect(ds!.cadence).toBe('0 4 * * 1');
      expect(ds!.digestTopicId).toBeNull();
      expect(ds!.budgetCapUsd).toBe(0);
      // THE invariant: enabled must NOT be present in the seeded defaults.
      expect('enabled' in (ds as object)).toBe(false);
    }
  });

  it('applyDefaults seeds the block on an empty config, with enabled absent (0/null preserved)', () => {
    const config: Record<string, unknown> = {};
    const { patched } = applyDefaults(config, getMigrationDefaults('managed-project'));
    expect(patched).toBe(true);
    const ds = (config.maintenance as { doorwayScan?: Record<string, unknown> }).doorwayScan!;
    expect(ds.scope).toBe('free-probes');
    expect(ds.cadence).toBe('0 4 * * 1');
    expect(ds.budgetCapUsd).toBe(0); // falsy 0 is seeded (add-missing uses `key in`, not `||`)
    expect(ds.digestTopicId).toBeNull(); // null is seeded
    expect('enabled' in ds).toBe(false); // never seeded
  });

  it('applyDefaults NEVER clobbers an operator override, and never adds enabled the operator omitted', () => {
    const config: Record<string, unknown> = {
      maintenance: { doorwayScan: { scope: '+liveness', budgetCapUsd: 5 } },
    };
    applyDefaults(config, getMigrationDefaults('managed-project'));
    const ds = (config.maintenance as { doorwayScan: Record<string, unknown> }).doorwayScan;
    expect(ds.scope).toBe('+liveness'); // operator value preserved
    expect(ds.budgetCapUsd).toBe(5); // operator value preserved
    expect(ds.cadence).toBe('0 4 * * 1'); // missing sub-field backfilled
    expect('enabled' in ds).toBe(false); // still not added
  });

  it('an operator who explicitly set enabled:false keeps it (never removed)', () => {
    const config: Record<string, unknown> = { maintenance: { doorwayScan: { enabled: false } } };
    applyDefaults(config, getMigrationDefaults('managed-project'));
    const ds = (config.maintenance as { doorwayScan: Record<string, unknown> }).doorwayScan;
    expect(ds.enabled).toBe(false); // operator's explicit kill-switch preserved
    expect(ds.scope).toBe('free-probes'); // missing sibling still backfilled
  });

  it('is idempotent: a second applyDefaults pass adds nothing', () => {
    const config: Record<string, unknown> = {};
    applyDefaults(config, getMigrationDefaults('managed-project'));
    const { patched: patched2, changes } = applyDefaults(config, getMigrationDefaults('managed-project'));
    expect(patched2).toBe(false);
    expect(changes.filter((c) => c.includes('doorwayScan'))).toHaveLength(0);
  });
});

describe('PostUpdateMigrator.migrate() seeds maintenance.doorwayScan on an existing agent', () => {
  let tmpProjectDir: string;
  let tmpStateDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorway-cfg-'));
    tmpStateDir = path.join(tmpProjectDir, '.instar');
    fs.mkdirSync(tmpStateDir, { recursive: true });
    configPath = path.join(tmpStateDir, 'config.json');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpProjectDir, { recursive: true, force: true, operation: 'tests/unit/doorway-config-migration.test.ts' });
  });

  it('an existing config with no maintenance block gets it on update (Migration Parity), enabled absent', () => {
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'x', agentType: 'managed-project', port: 4042 }, null, 2));
    new PostUpdateMigrator({ stateDir: tmpStateDir, projectDir: tmpProjectDir, version: '1.0.0' }).migrate();
    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const ds = after.maintenance?.doorwayScan;
    expect(ds).toBeDefined();
    expect(ds.scope).toBe('free-probes');
    expect(ds.cadence).toBe('0 4 * * 1');
    expect(ds.digestTopicId).toBeNull();
    expect(ds.budgetCapUsd).toBe(0);
    expect('enabled' in ds).toBe(false);
  });
});
