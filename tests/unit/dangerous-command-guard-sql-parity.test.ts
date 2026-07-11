import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

function migratorGuard(): string {
  const migrator = new PostUpdateMigrator({
    stateDir: '/tmp/sql-shape-parity', projectDir: '/tmp/sql-shape-parity',
    port: 4042, sessions: { claudePath: 'claude' },
  } as never);
  return (migrator as unknown as { getDangerousCommandGuard(): string }).getDangerousCommandGuard();
}

describe('dangerous-command SQL-shape writer parity', () => {
  it('keeps init and the always-overwrite migrator on the shaped matcher contract', () => {
    const init = fs.readFileSync(path.join(ROOT, 'src/commands/init.ts'), 'utf8');
    const migrator = migratorGuard();
    for (const marker of ['for sql_spec in', 'SQL must look like a statement', 'sql_pattern']) {
      expect(init).toContain(marker);
      expect(migrator).toContain(marker);
    }
    expect((init.match(/for sql_spec in/g) ?? [])).toHaveLength(1);
    expect((migrator.match(/for sql_spec in/g) ?? [])).toHaveLength(1);
  });

  it('keeps every non-SQL risky pattern byte-present in both writers', () => {
    const init = fs.readFileSync(path.join(ROOT, 'src/commands/init.ts'), 'utf8');
    const migrator = migratorGuard();
    const patterns = [
      ['git', 'push', '--force'].join(' '),
      ['git', 'push', '-f'].join(' '),
      ['git', 'reset', '--hard'].join(' '),
      ['git', 'clean', '-fd'].join(' '),
    ];
    for (const pattern of patterns) {
      expect(init).toContain(pattern);
      expect(migrator).toContain(pattern);
    }
  });
});
