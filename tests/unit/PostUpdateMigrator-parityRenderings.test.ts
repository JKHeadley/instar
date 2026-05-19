/**
 * Verifies the PostUpdateMigrator parity-renderings backfill iterates the
 * registered parity rules and remediates each canonical instance.
 *
 * This is the Migration Parity §5-style backfill for primitive-renderings
 * that PRs #252 (Skill), #253 (Hook), #254 (Memory) deferred — existing
 * deployed agents pick up the canonical→framework rendering on update.
 *
 * Tests use the _replaceParityRuleForTest seam to inject a deterministic
 * fake rule and verify the orchestration without depending on real
 * canonical sources existing on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { _replaceParityRuleForTest } from '../../src/providers/parity/registry.js';
import type {
  ParityRule,
  FunctionalPrimitive,
} from '../../src/providers/parity/types.js';

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

const NOOP: Pick<ParityRule, 'listInstances' | 'verify' | 'listOrphans' | 'removeOrphans'> = {
  async listInstances() { return []; },
  async verify() { return { ok: true, mismatches: [] }; },
  async listOrphans() { return []; },
  async removeOrphans() { return []; },
};

function makeStubRule(opts: {
  primitive: FunctionalPrimitive;
  instances: string[];
  remediateImpl?: (instance: string, framework: string) => Promise<void>;
  alwaysOverwrite?: boolean;
}): ParityRule {
  return {
    ...NOOP,
    primitive: opts.primitive,
    frameworks: ['claude-code', 'codex-cli'],
    remediationPolicy: 'mirror-trust',
    alwaysOverwrite: opts.alwaysOverwrite,
    async listInstances() { return opts.instances; },
    async remediate(_root, instance, framework) {
      if (opts.remediateImpl) await opts.remediateImpl(instance, framework);
    },
  };
}

function isolateRules(rules: ParityRule[]): () => void {
  // Replace all known primitive rules with NOOP, then layer in the test rules.
  const all: FunctionalPrimitive[] = ['skill', 'hook', 'agent', 'tool', 'memory'];
  const restores: Array<() => void> = [];
  for (const p of all) {
    const test = rules.find(r => r.primitive === p);
    if (test) {
      restores.push(_replaceParityRuleForTest(p, test));
    } else {
      restores.push(_replaceParityRuleForTest(p, { ...NOOP, primitive: p, frameworks: ['claude-code'], remediationPolicy: 'mirror-trust' } as ParityRule));
    }
  }
  return () => { for (const r of restores.reverse()) r(); };
}

describe('PostUpdateMigrator — parity-renderings backfill', () => {
  let projectDir: string;
  let configPath: string;
  let restoreRules: (() => void) | null = null;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-parity-renderings-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    configPath = path.join(projectDir, '.instar', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ enabledFrameworks: ['claude-code'] }));
  });

  afterEach(() => {
    if (restoreRules) { restoreRules(); restoreRules = null; }
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-parityRenderings.test.ts:89' });
  });

  it('iterates all registered rules and calls remediate() for each instance/framework', async () => {
    const calls: string[] = [];
    restoreRules = isolateRules([
      makeStubRule({
        primitive: 'skill',
        instances: ['foo', 'bar'],
        remediateImpl: async (i, f) => { calls.push(`skill/${i}/${f}`); },
      }),
      makeStubRule({
        primitive: 'hook',
        instances: ['session-start/inject.sh'],
        alwaysOverwrite: true,
        remediateImpl: async (i, f) => { calls.push(`hook/${i}/${f}`); },
      }),
    ]);

    const result = await newMigrator(projectDir).migrateAsync();

    expect(result.errors).toEqual([]);
    expect(calls).toContain('skill/foo/claude-code');
    expect(calls).toContain('skill/bar/claude-code');
    expect(calls).toContain('hook/session-start/inject.sh/claude-code');
    expect(result.upgraded.filter(u => u.startsWith('parity-renderings:')).length).toBe(3);
  });

  it('honors enabledFrameworks from config (claude-code-only agents skip codex)', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ enabledFrameworks: ['claude-code'] }));
    const calls: string[] = [];
    restoreRules = isolateRules([
      makeStubRule({
        primitive: 'skill',
        instances: ['foo'],
        remediateImpl: async (i, f) => { calls.push(`${i}/${f}`); },
      }),
    ]);

    await newMigrator(projectDir).migrateAsync();

    expect(calls).toEqual(['foo/claude-code']); // no codex-cli call
  });

  it('renders to all enabled frameworks when both are configured', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ enabledFrameworks: ['claude-code', 'codex-cli'] }));
    const calls: string[] = [];
    restoreRules = isolateRules([
      makeStubRule({
        primitive: 'skill',
        instances: ['foo'],
        remediateImpl: async (i, f) => { calls.push(`${i}/${f}`); },
      }),
    ]);

    await newMigrator(projectDir).migrateAsync();

    expect(calls.sort()).toEqual(['foo/claude-code', 'foo/codex-cli']);
  });

  it('captures refuse-on-user-edit-conflict as a skip, not an error', async () => {
    restoreRules = isolateRules([
      makeStubRule({
        primitive: 'skill',
        instances: ['foo'],
        remediateImpl: async () => { throw new Error('refused to remediate foo on claude-code due to user-edit-conflict: user-edited'); },
      }),
    ]);

    const result = await newMigrator(projectDir).migrateAsync();

    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('user-edit-conflict'))).toBe(true);
  });

  it('captures non-conflict remediation errors as errors', async () => {
    restoreRules = isolateRules([
      makeStubRule({
        primitive: 'skill',
        instances: ['foo'],
        remediateImpl: async () => { throw new Error('disk full'); },
      }),
    ]);

    const result = await newMigrator(projectDir).migrateAsync();

    expect(result.errors.some(e => e.includes('disk full'))).toBe(true);
  });

  it('is idempotent — second run is a no-op via the migration marker', async () => {
    const calls1: string[] = [];
    restoreRules = isolateRules([
      makeStubRule({
        primitive: 'skill',
        instances: ['foo'],
        remediateImpl: async (i, f) => { calls1.push(`${i}/${f}`); },
      }),
    ]);

    await newMigrator(projectDir).migrateAsync();
    expect(calls1.length).toBe(1);

    // Re-install the same rules; second migrateAsync should skip via marker.
    const result2 = await newMigrator(projectDir).migrateAsync();
    expect(result2.skipped.some(s => s.includes('parity-renderings: already migrated'))).toBe(true);
    expect(calls1.length).toBe(1); // remediate NOT called again
  });

  it('records migration marker in config._instar_migrations', async () => {
    restoreRules = isolateRules([
      makeStubRule({
        primitive: 'skill',
        instances: ['foo'],
        remediateImpl: async () => { /* no-op */ },
      }),
    ]);

    await newMigrator(projectDir).migrateAsync();

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const migrations = config._instar_migrations as string[];
    expect(migrations).toBeDefined();
    expect(migrations.some(m => m.startsWith('parity-renderings-backfill-v1'))).toBe(true);
  });

  it('marks empty-canonical-source case as a skip (new-agent path)', async () => {
    restoreRules = isolateRules([
      makeStubRule({
        primitive: 'skill',
        instances: [], // no canonical sources
      }),
    ]);

    const result = await newMigrator(projectDir).migrateAsync();

    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('no canonical instances found'))).toBe(true);
  });

  it('continues past one rule\'s listInstances failure to other rules', async () => {
    const calls: string[] = [];
    restoreRules = isolateRules([
      {
        ...NOOP,
        primitive: 'skill',
        frameworks: ['claude-code'],
        remediationPolicy: 'mirror-trust',
        async listInstances() { throw new Error('disk corruption'); },
      } as ParityRule,
      makeStubRule({
        primitive: 'hook',
        instances: ['foo.sh'],
        remediateImpl: async (i, f) => { calls.push(`${i}/${f}`); },
      }),
    ]);

    const result = await newMigrator(projectDir).migrateAsync();

    expect(result.errors.some(e => e.includes('skill') && e.includes('disk corruption'))).toBe(true);
    expect(calls).toEqual(['foo.sh/claude-code']); // hook still ran
  });

  it('skips gracefully when config.json is missing', async () => {
    SafeFsExecutor.safeRmSync(configPath, { operation: 'tests/unit/PostUpdateMigrator-parityRenderings.test.ts:212' });
    restoreRules = isolateRules([
      makeStubRule({
        primitive: 'skill',
        instances: ['foo'],
        remediateImpl: async () => { throw new Error('should not be called'); },
      }),
    ]);

    const result = await newMigrator(projectDir).migrateAsync();

    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('config.json not found'))).toBe(true);
  });

  it('migrateAsync wraps sync migrate() + async backfill', async () => {
    restoreRules = isolateRules([]);

    const result = await newMigrator(projectDir).migrateAsync();

    // Confirm result is a proper MigrationResult shape from migrateAsync.
    expect(Array.isArray(result.upgraded)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });
});
