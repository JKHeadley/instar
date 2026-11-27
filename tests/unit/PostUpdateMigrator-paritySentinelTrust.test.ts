/**
 * Trust-journey decision 9: `parity-sentinel` is an Instar system service on a code-constant
 * allowlist, never a person kind. The migrator no longer seeds a trust level for it, and an entry an
 * earlier update seeded is left in place, unused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SYSTEM_SERVICES } from '../../src/data/effect-kinds.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('PostUpdateMigrator — parity-sentinel trust seed retired', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-retired-'));
    fs.mkdirSync(path.join(projectDir, '.instar', 'state'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), '{}');
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-paritySentinelTrust.test.ts' }); });

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateParitySentinelTrust(r: MigrationResult): void }).migrateParitySentinelTrust(result);
    return result;
  };

  it('seeds nothing and reports the retirement', () => {
    const r = run();
    expect(r.skipped.some((x) => x.includes('retired'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.instar', 'state', 'trust-profile.json'))).toBe(false);
  });

  it('leaves an earlier seeded entry untouched', () => {
    const p = path.join(projectDir, '.instar', 'state', 'trust-profile.json');
    const before = JSON.stringify({ services: { 'parity-sentinel': { operations: { modify: { level: 'log', source: 'default' } } } } });
    fs.writeFileSync(p, before);
    run();
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  it('parity-sentinel is on the system allowlist', () => {
    expect(SYSTEM_SERVICES).toContain('parity-sentinel');
  });
});
