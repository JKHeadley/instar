import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const run = (dir: string): MigrationResult => {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
};

describe('Ultracode spawn awareness migration', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ultracode-awareness-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Existing\n');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-ultracodeSpawn.test.ts' }));

  it('adds the dark per-spawn surface once', () => {
    expect(run(dir).errors).toEqual([]);
    const first = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(first).toContain('Ultracode one-shot spawn');
    expect(first).toContain('"ultracode":true');
    run(dir);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(first);
  });

  it('keeps new-install awareness in parity', () => {
    const md = generateClaudeMd({ projectName: 'test', port: 4042 } as Parameters<typeof generateClaudeMd>[0]);
    expect(md).toContain('Ultracode one-shot spawn');
    expect(md).toContain('/sessions/spawn');
  });
});
