/**
 * Step 9 (Migration parity) for live credential re-pointing (WS5.2, CMT-1372).
 *
 * Verifies that EXISTING agents receive the feature on update — not just fresh
 * installs:
 *   1. migrateClaudeMd appends the "Live Credential Re-pointing" awareness
 *      section (Agent Awareness Standard), idempotently, preserving prior content.
 *   2. The generateClaudeMd template emits the same section so fresh installs
 *      get it too (parity between the two CLAUDE.md sources).
 *   3. migrateConfig installs the DARK defaults block
 *      (subscriptionPool.credentialRepointing = { enabled:false, dryRun:true,
 *      manualLeversEnabled:true }) on a config that lacks it — and NEVER clobbers
 *      an operator's explicit enabled:true (the Migration Parity Standard's
 *      existence-checked, add-missing contract via ConfigDefaults + applyDefaults).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const SECTION_MARKER = 'Live Credential Re-pointing (move a pool account';

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

describe('PostUpdateMigrator — Live Credential Re-pointing CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-credrepoint-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-credentialRepointing.test.ts:cleanup',
    });
  });

  it('adds the section when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(
      result.upgraded.some(u => u.includes('Live Credential Re-pointing awareness section')),
    ).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(SECTION_MARKER);
    // The two proactive triggers must survive into the deployed CLAUDE.md.
    expect(after).toContain('GET /credentials/locations');
    expect(after).toContain('/credentials/set-default');
    expect(after).toContain('flip my default account');
    // Honesty guard: read the ledger, never infer from `claude auth status`.
    expect(after).toContain('claude auth status');
    // Dark-ship posture is stated.
    expect(after).toContain('subscriptionPool.credentialRepointing.enabled');
  });

  it('is idempotent — re-running does not add a duplicate section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result2.errors).toEqual([]);
    expect(
      result2.upgraded.some(u => u.includes('Live Credential Re-pointing awareness section')),
    ).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    const markerMatches = afterSecond.split(SECTION_MARKER).length - 1;
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

  it('does not run when CLAUDE.md is missing (graceful skip)', () => {
    expect(fs.existsSync(claudeMdPath)).toBe(false);

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('CLAUDE.md'))).toBe(true);
  });
});

describe('generateClaudeMd template includes the Live Credential Re-pointing section', () => {
  it('the source template emits the section so fresh installs get it too', () => {
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain(SECTION_MARKER);
    expect(templateSource).toContain('/credentials/set-default');
    expect(templateSource).toContain('GET /credentials/locations');
  });
});

describe('PostUpdateMigrator — Live Credential Re-pointing config defaults (dark)', () => {
  let projectDir: string;
  let configPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-credrepoint-cfg-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    configPath = path.join(projectDir, '.instar', 'config.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-credentialRepointing.test.ts:cfg-cleanup',
    });
  });

  it('installs the DARK credentialRepointing block on an existing config that lacks it', () => {
    // A pre-feature config: has an authToken (so dashboardPin generation runs)
    // but no subscriptionPool block at all.
    fs.writeFileSync(configPath, JSON.stringify({ authToken: 'tok', agentType: 'standalone' }, null, 2));

    const result = runConfigMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.subscriptionPool?.credentialRepointing).toBeDefined();
    // Ships dark + dry-run for EVERYONE — writes OAuth credentials, so the
    // default must never resolve live (DARK_GATE_EXCLUSIONS destructive).
    expect(after.subscriptionPool.credentialRepointing.enabled).toBe(false);
    expect(after.subscriptionPool.credentialRepointing.dryRun).toBe(true);
    expect(after.subscriptionPool.credentialRepointing.manualLeversEnabled).toBe(true);
  });

  it('NEVER clobbers an operator who explicitly enabled the feature', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          authToken: 'tok',
          agentType: 'standalone',
          subscriptionPool: { credentialRepointing: { enabled: true, dryRun: false } },
        },
        null,
        2,
      ),
    );

    const result = runConfigMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // Add-missing only: the operator's explicit live values are preserved.
    expect(after.subscriptionPool.credentialRepointing.enabled).toBe(true);
    expect(after.subscriptionPool.credentialRepointing.dryRun).toBe(false);
    // The missing sibling default is still filled in (existence-checked merge).
    expect(after.subscriptionPool.credentialRepointing.manualLeversEnabled).toBe(true);
  });

  it('is idempotent — a second migration makes no further credentialRepointing change', () => {
    fs.writeFileSync(configPath, JSON.stringify({ authToken: 'tok', agentType: 'standalone' }, null, 2));

    runConfigMigration(newMigrator(projectDir));
    const afterFirst = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    const result2 = runConfigMigration(newMigrator(projectDir));
    const afterSecond = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    expect(result2.errors).toEqual([]);
    expect(afterSecond.subscriptionPool.credentialRepointing).toEqual(
      afterFirst.subscriptionPool.credentialRepointing,
    );
  });
});
