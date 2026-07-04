/**
 * Migration parity (Step 9) for the External-Hog zombie auto-kill sentinel (CMT-1901).
 *
 * Verifies EXISTING agents receive the feature on update — not just fresh installs:
 *   1. migrateConfig installs the DARK defaults block (monitoring.externalHogSentinel =
 *      { dryRun:true, ...kill-gate knobs }, `enabled` OMITTED so the developmentAgent gate
 *      resolves it live-on-dev / dark-fleet) on a config lacking it, via ConfigDefaults +
 *      applyDefaults (add-missing).
 *   2. It STRIPS a default-shaped enabled:false (the #1001 force-dark mechanism) so the gate
 *      resolves, and NEVER clobbers an operator's explicit enabled:true.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { migrateConfigExternalHogSentinelDevGate } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const SECTION_MARKER = 'External-Hog Zombie Auto-Kill Sentinel';

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
}
function runConfigMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateConfig(r: MigrationResult): void }).migrateConfig(result);
  return result;
}
function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('migrateConfigExternalHogSentinelDevGate — the pure strip predicate', () => {
  it('strips a default-shaped enabled:false', () => {
    const cfg: Record<string, unknown> = { monitoring: { externalHogSentinel: { enabled: false, dryRun: true } } };
    expect(migrateConfigExternalHogSentinelDevGate(cfg)).toBe(true);
    expect((cfg.monitoring as any).externalHogSentinel).not.toHaveProperty('enabled');
    expect((cfg.monitoring as any).externalHogSentinel.dryRun).toBe(true); // canary preserved
  });
  it('preserves an explicit enabled:true (operator fleet-flip)', () => {
    const cfg: Record<string, unknown> = { monitoring: { externalHogSentinel: { enabled: true } } };
    expect(migrateConfigExternalHogSentinelDevGate(cfg)).toBe(false);
    expect((cfg.monitoring as any).externalHogSentinel.enabled).toBe(true);
  });
  it('is a no-op when the block or key is absent (existence-checked)', () => {
    expect(migrateConfigExternalHogSentinelDevGate({})).toBe(false);
    expect(migrateConfigExternalHogSentinelDevGate({ monitoring: {} })).toBe(false);
    expect(migrateConfigExternalHogSentinelDevGate({ monitoring: { externalHogSentinel: { dryRun: true } } })).toBe(false);
  });
});

describe('PostUpdateMigrator — External-Hog sentinel config defaults (dark)', () => {
  let projectDir: string;
  let configPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-exthog-cfg-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    configPath = path.join(projectDir, '.instar', 'config.json');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-externalHogSentinel.test.ts:cleanup' });
  });

  it('installs the block (enabled OMITTED — dev-gate-resolved; dryRun canary present) on a config lacking it', () => {
    fs.writeFileSync(configPath, JSON.stringify({ authToken: 'tok', agentType: 'standalone' }, null, 2));
    const result = runConfigMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.monitoring?.externalHogSentinel).toBeDefined();
    expect(after.monitoring.externalHogSentinel).not.toHaveProperty('enabled'); // dev-gate-resolved
    expect(after.monitoring.externalHogSentinel.dryRun).toBe(true); // kill-safety canary
    expect(after.monitoring.externalHogSentinel.cpuCoreThreshold).toBe(1.5);
  });

  it('STRIPS a default-shaped enabled:false from an existing config', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      authToken: 'tok', agentType: 'standalone',
      monitoring: { externalHogSentinel: { enabled: false, dryRun: true } },
    }, null, 2));
    const result = runConfigMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.monitoring.externalHogSentinel).not.toHaveProperty('enabled'); // stripped
    expect(after.monitoring.externalHogSentinel.dryRun).toBe(true); // canary preserved
  });

  it('NEVER clobbers an operator who explicitly enabled the feature', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      authToken: 'tok', agentType: 'standalone',
      monitoring: { externalHogSentinel: { enabled: true, dryRun: false } },
    }, null, 2));
    const result = runConfigMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.monitoring.externalHogSentinel.enabled).toBe(true); // preserved
    expect(after.monitoring.externalHogSentinel.dryRun).toBe(false); // preserved (operator armed a live soak)
  });

  it('is idempotent — a second migration makes no further externalHogSentinel change', () => {
    fs.writeFileSync(configPath, JSON.stringify({ authToken: 'tok', agentType: 'standalone' }, null, 2));
    runConfigMigration(newMigrator(projectDir));
    const afterFirst = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    runConfigMigration(newMigrator(projectDir));
    const afterSecond = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(afterSecond.monitoring.externalHogSentinel).toEqual(afterFirst.monitoring.externalHogSentinel);
  });
});

describe('PostUpdateMigrator — External-Hog CLAUDE.md agent-awareness section', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-exthog-md-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-externalHogSentinel.test.ts:md' });
  });

  it('adds the section (with the key routes + posture) when CLAUDE.md lacks it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nExisting content.\n');
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('External-Hog Zombie Auto-Kill Sentinel section'))).toBe(true);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(SECTION_MARKER);
    expect(after).toContain('/external-hog/arm');       // the PIN-gated arm route
    expect(after).toContain('/external-hog/disarm');    // the disarm route
    expect(after).toContain('PIN-gated');               // the arm is a human action
    expect(after).toContain("floor_pass && classifier==='kill'"); // the two-key rule
  });

  it('is idempotent + preserves existing content above the section', () => {
    const original = '# CLAUDE.md\n\n## My Section\n\nKeep me.\n';
    fs.writeFileSync(claudeMdPath, original);
    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(result2.upgraded.some((u) => u.includes('External-Hog Zombie Auto-Kill Sentinel section'))).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.startsWith(original)).toBe(true);
    expect(afterSecond.split(SECTION_MARKER).length - 1).toBe(1); // exactly one copy
  });
});

describe('generateClaudeMd template includes the External-Hog section (fresh-install parity)', () => {
  it('the source template emits the section so fresh installs get it too', () => {
    const templateSource = fs.readFileSync(path.join(process.cwd(), 'src/scaffold/templates.ts'), 'utf-8');
    expect(templateSource).toContain('EXTERNAL_HOG_CLAUDEMD_SECTION');
  });
});
