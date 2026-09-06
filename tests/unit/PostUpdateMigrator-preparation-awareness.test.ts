// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const dirs: string[] = [];

function run(projectDir: string): Result {
  const migrator = new PostUpdateMigrator({
    projectDir, stateDir: path.join(projectDir, '.instar'), port: 4040,
    hasTelegram: false, projectName: 'test',
  });
  const result: Result = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: Result): void }).migrateClaudeMd(result);
  return result;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'preparation-awareness-test.cleanup' });
  }
});

describe('PostUpdateMigrator preparation-carrier awareness', () => {
  it('adds the awareness contract to existing CLAUDE.md files idempotently', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preparation-awareness-'));
    dirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, '.instar'));
    const file = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Existing agent\n');

    const first = run(projectDir);
    const afterFirst = fs.readFileSync(file, 'utf8');
    expect(afterFirst).toContain('Pre-admission continuation carrier');
    expect(afterFirst).toContain('preparationCarrierEnabled');
    expect(afterFirst).toContain('active:false');
    expect(first.upgraded).toContain('CLAUDE.md: added pre-admission autonomous continuation carrier awareness');

    const second = run(projectDir);
    expect(fs.readFileSync(file, 'utf8')).toBe(afterFirst);
    expect(second.upgraded).not.toContain('CLAUDE.md: added pre-admission autonomous continuation carrier awareness');
    expect(second.errors).toEqual([]);
  });
});
