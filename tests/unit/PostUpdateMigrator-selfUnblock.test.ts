/**
 * Migration parity (§10) for "Self-Unblock Before Escalating" (CMT-1519).
 *
 * Verifies EXISTING agents receive the feature on update — not just fresh installs:
 *   1. migrateClaudeMd appends the "Self-Unblock Before Escalating" awareness
 *      section (Agent Awareness Standard), idempotently, preserving prior content,
 *      and leading with the BOUNDARY.
 *   2. generateClaudeMd emits the same section so fresh installs get it too.
 *   3. migrateConfig installs the nested OMITTED-`enabled` dev-gate blocks
 *      (monitoring.blockerLedger.{selfUnblockChecklist,durableVaultSession}) on a
 *      config that lacks them, STRIPS a default-shaped enabled:false, and never
 *      clobbers an operator's explicit enabled:true.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, migrateConfigSelfUnblockChecklistDevGate } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const SECTION_MARKER = 'Self-Unblock Before Escalating';

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

function runConfigMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateConfig(r: MigrationResult): void }).migrateConfig(result);
  return result;
}

describe('PostUpdateMigrator — Self-Unblock CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-selfunblock-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-selfUnblock.test.ts:cleanup',
    });
  });

  it('adds the section (boundary-first) when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('Self-Unblock Before Escalating'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(SECTION_MARKER);
    // Leads with the BOUNDARY (within permissions / org-granted scope). The
    // migrated section is first-person (the agent's own CLAUDE.md).
    expect(after).toContain('WITHIN my permissions');
    // The rung ladder is present, named.
    expect(after).toContain('Rung 0');
    expect(after).toContain('Rung 1');
    expect(after).toContain('Rung 2');
    expect(after).toContain('Rung FLOOR');
    // Verified-principal (Know Your Principal).
    expect(after).toContain('VERIFIED principal');
    // The read surface.
    expect(after).toContain('/blockers/self-unblock-runs');
  });

  it('is idempotent — re-running does not add a duplicate section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result2.errors).toEqual([]);
    expect(result2.upgraded.some((u) => u.includes('Self-Unblock Before Escalating'))).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    // The section heading appears exactly once.
    const markerMatches = afterSecond.split('### Self-Unblock Before Escalating').length - 1;
    expect(markerMatches).toBe(1);
  });

  it('preserves existing CLAUDE.md content above the new section', () => {
    const original = '# CLAUDE.md\n\n## My Custom Section\n\nDo not delete this.\n';
    fs.writeFileSync(claudeMdPath, original);

    runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(after.startsWith(original)).toBe(true);
    expect(after.length).toBeGreaterThan(original.length);
  });
});

describe('generateClaudeMd template includes the Self-Unblock section', () => {
  it('the source template emits the boundary-first section so fresh installs get it too', () => {
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain('Self-Unblock Before Escalating');
    expect(templateSource).toContain('WITHIN your permissions');
    expect(templateSource).toContain('/blockers/self-unblock-runs');
  });
});

describe('migrateConfigSelfUnblockChecklistDevGate — strip migration', () => {
  it('strips a default-shaped enabled:false on selfUnblockChecklist so the dev-gate resolves live', () => {
    const config: Record<string, unknown> = {
      monitoring: { blockerLedger: { selfUnblockChecklist: { enabled: false } } },
    };
    expect(migrateConfigSelfUnblockChecklistDevGate(config)).toBe(true);
    const bl = (config.monitoring as any).blockerLedger;
    expect(bl.selfUnblockChecklist).not.toHaveProperty('enabled');
  });

  it('strips a default-shaped enabled:false on durableVaultSession too', () => {
    const config: Record<string, unknown> = {
      monitoring: { blockerLedger: { durableVaultSession: { enabled: false, ttlMs: 600000 } } },
    };
    expect(migrateConfigSelfUnblockChecklistDevGate(config)).toBe(true);
    const bl = (config.monitoring as any).blockerLedger;
    expect(bl.durableVaultSession).not.toHaveProperty('enabled');
    // The unrelated tunable is preserved.
    expect(bl.durableVaultSession.ttlMs).toBe(600000);
  });

  it('preserves an explicit enabled:true (operator fleet-flip)', () => {
    const config: Record<string, unknown> = {
      monitoring: { blockerLedger: { selfUnblockChecklist: { enabled: true } } },
    };
    expect(migrateConfigSelfUnblockChecklistDevGate(config)).toBe(false);
    const bl = (config.monitoring as any).blockerLedger;
    expect(bl.selfUnblockChecklist.enabled).toBe(true);
  });

  it('is a no-op when the blocks are absent or already omitted', () => {
    expect(migrateConfigSelfUnblockChecklistDevGate({})).toBe(false);
    expect(migrateConfigSelfUnblockChecklistDevGate({ monitoring: {} })).toBe(false);
    expect(
      migrateConfigSelfUnblockChecklistDevGate({ monitoring: { blockerLedger: { selfUnblockChecklist: {} } } }),
    ).toBe(false);
  });
});

describe('PostUpdateMigrator — Self-Unblock config defaults (nested OMITTED-enabled dev-gate)', () => {
  let projectDir: string;
  let configPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-selfunblock-cfg-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    configPath = path.join(projectDir, '.instar', 'config.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-selfUnblock.test.ts:cfg-cleanup',
    });
  });

  it('installs the nested blocks (enabled OMITTED — dev-gate-resolved) on a config that lacks them', () => {
    fs.writeFileSync(configPath, JSON.stringify({ authToken: 'tok', agentType: 'standalone' }, null, 2));

    const result = runConfigMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.monitoring?.blockerLedger?.selfUnblockChecklist).toBeDefined();
    expect(after.monitoring.blockerLedger.selfUnblockChecklist).not.toHaveProperty('enabled');
    expect(after.monitoring.blockerLedger.durableVaultSession).toBeDefined();
    expect(after.monitoring.blockerLedger.durableVaultSession).not.toHaveProperty('enabled');
  });

  it('STRIPS a default-shaped enabled:false from an existing config (so the dev-gate resolves live)', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          authToken: 'tok',
          agentType: 'standalone',
          monitoring: { blockerLedger: { selfUnblockChecklist: { enabled: false }, durableVaultSession: { enabled: false } } },
        },
        null,
        2,
      ),
    );

    const result = runConfigMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.monitoring.blockerLedger.selfUnblockChecklist).not.toHaveProperty('enabled');
    expect(after.monitoring.blockerLedger.durableVaultSession).not.toHaveProperty('enabled');
  });

  it('NEVER clobbers an operator who explicitly enabled the feature', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          authToken: 'tok',
          agentType: 'standalone',
          monitoring: { blockerLedger: { selfUnblockChecklist: { enabled: true } } },
        },
        null,
        2,
      ),
    );

    const result = runConfigMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.monitoring.blockerLedger.selfUnblockChecklist.enabled).toBe(true);
  });

  it('is idempotent — a second migration makes no further self-unblock change', () => {
    fs.writeFileSync(configPath, JSON.stringify({ authToken: 'tok', agentType: 'standalone' }, null, 2));

    runConfigMigration(newMigrator(projectDir));
    const afterFirst = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    const result2 = runConfigMigration(newMigrator(projectDir));
    const afterSecond = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    expect(result2.errors).toEqual([]);
    expect(afterSecond.monitoring.blockerLedger).toEqual(afterFirst.monitoring.blockerLedger);
  });
});
