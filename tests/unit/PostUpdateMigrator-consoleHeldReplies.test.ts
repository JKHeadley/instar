import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('console guidance excludes delivery holds', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-console-held-guidance-'));
  const file = path.join(projectDir, 'CLAUDE.md');
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-consoleHeldReplies.test.ts:cleanup' }));

  it('ships fresh guidance and replaces stale installed guidance once', () => {
    const fresh = generateClaudeMd('test', 'TestAgent', 4042, false);
    expect(fresh).toContain('Delivery holds are internal recovery work');
    expect(fresh).not.toContain('held replies, open promises');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.writeFileSync(file, fresh.replace('open promises, live sessions', 'held replies, open promises, live sessions').replace('Delivery holds are internal recovery work, never a dashboard task. ', ''));
    const migrate = (): MigrationResult => {
      const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
      const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
      (m as unknown as { migrateClaudeMd(result: MigrationResult): void }).migrateClaudeMd(result);
      return result;
    };
    expect(migrate().upgraded).toContain('CLAUDE.md: removed held replies from console guidance');
    const once = fs.readFileSync(file, 'utf8');
    expect(once).not.toContain('held replies, open promises');
    expect(once).toContain('Delivery holds are internal recovery work');
    migrate();
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
  });
});
