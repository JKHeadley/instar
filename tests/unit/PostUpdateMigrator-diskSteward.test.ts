/**
 * Disk Steward migration parity (spec docs/specs/disk-steward.md §6): existing
 * agents get the CLAUDE.md section once; development agents get cleanup turned
 * on with an explicit value; fleet agents and set values are left alone; the
 * defaults block arrives through applyDefaults; everything is idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const run = (m: PostUpdateMigrator, method: 'migrateClaudeMd' | 'migrateConfig'): MigrationResult => {
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as Record<string, (r: MigrationResult) => void>)[method](r);
  return r;
};

describe('PostUpdateMigrator — Disk Steward', () => {
  let dir: string;
  const migrator = () => new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const cfgPath = () => path.join(dir, '.instar', 'config.json');
  const readCfg = () => JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-disk-steward-mig-')); fs.mkdirSync(path.join(dir, '.instar'), { recursive: true }); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-diskSteward.test.ts' }); });

  it('adds the CLAUDE.md section once', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# CLAUDE.md\n');
    expect(run(migrator(), 'migrateClaudeMd').errors).toEqual([]);
    const once = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(once).toContain('## Disk Steward');
    expect(once).toContain('http://localhost:4042/disk-steward');
    run(migrator(), 'migrateClaudeMd');
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').split('## Disk Steward').length).toBe(2);
  });

  it('a development agent gets cleanup on (explicit), plus the defaults; idempotent', () => {
    fs.writeFileSync(cfgPath(), JSON.stringify({ developmentAgent: true, monitoring: {} }));
    run(migrator(), 'migrateConfig');
    const c = readCfg();
    expect(c.monitoring.diskSteward.enabled).toBe(true);
    expect(c.monitoring.diskSteward.prune.enabled).toBe(true);
    expect(c.monitoring.diskSteward.prune.npmCacheMaxGiB).toBe(5);
    run(migrator(), 'migrateConfig');
    expect(readCfg().monitoring.diskSteward.prune.enabled).toBe(true);
  });

  it('a fleet agent gets the watcher on and cleanup off; an operator choice is never changed', () => {
    fs.writeFileSync(cfgPath(), JSON.stringify({ monitoring: {} }));
    run(migrator(), 'migrateConfig');
    expect(readCfg().monitoring.diskSteward).toMatchObject({ enabled: true, prune: { enabled: false } });
    fs.writeFileSync(cfgPath(), JSON.stringify({ developmentAgent: true, monitoring: { diskSteward: { enabled: false, prune: { enabled: false } } } }));
    run(migrator(), 'migrateConfig');
    expect(readCfg().monitoring.diskSteward).toMatchObject({ enabled: false, prune: { enabled: false } });
  });
});
