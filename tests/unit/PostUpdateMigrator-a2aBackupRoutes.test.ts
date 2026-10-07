/**
 * Migration parity for A2A backup routes (docs/specs/a2a-backup-routes.md):
 * the CLAUDE.md awareness section reaches existing agents (sniff key
 * `A2A backup routes`), idempotently; the template carries the same section
 * for new agents; ConfigDefaults adds nothing (enabled omitted on purpose) and
 * the dev gate decides via a DEV_GATED_FEATURES entry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import { resolveBackupRoutesEnabled } from '../../src/threadline/backupRoutes.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('PostUpdateMigrator — A2A backup routes', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-backup-routes-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-a2aBackupRoutes.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('adds the section once and is idempotent', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    const r1 = run();
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded).toContain('CLAUDE.md: added A2A backup routes section');
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('### A2A backup routes');
    expect(after).toContain('the relay copy carries the same message id, the same thread and a resend mark');
    const r2 = run();
    expect(r2.upgraded).not.toContain('CLAUDE.md: added A2A backup routes section');
    expect(fs.readFileSync(claudeMdPath, 'utf-8').split('### A2A backup routes').length - 1).toBe(1);
  });

  it('the template carries the same section for new agents', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain('### A2A backup routes');
    expect(md).toContain('A credential addressed by fingerprint still goes over the relay');
  });

  it('no config default is added; the dev gate decides (live on dev, dark on fleet)', () => {
    const d = getMigrationDefaults('standalone') as { threadline?: Record<string, unknown> };
    expect(d.threadline?.backupRoutes).toBeUndefined();
    expect(DEV_GATED_FEATURES.filter((f) => f.configPath === 'threadline.backupRoutes.enabled')).toHaveLength(1);
    const dev: Record<string, unknown> = { developmentAgent: true };
    applyDefaults(dev, getMigrationDefaults('standalone'));
    const fleet: Record<string, unknown> = { developmentAgent: false };
    applyDefaults(fleet, getMigrationDefaults('standalone'));
    expect(resolveBackupRoutesEnabled(undefined, dev as never)).toBe(true);
    expect(resolveBackupRoutesEnabled(undefined, fleet as never)).toBe(false);
  });
});
