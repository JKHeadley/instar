import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-leaseMedium.test.ts:cleanup' }); });

describe('PostUpdateMigrator lease-medium awareness', () => {
  it('adds the awareness text once using a content-sniffing guard', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-medium-migrate-'));
    dirs.push(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Existing\n');
    const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4040 } as never);
    const run = () => {
      const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
      (migrator as unknown as { migrateClaudeMd(r: typeof result): void }).migrateClaudeMd(result);
      return result;
    };
    expect(run().upgraded).toContain('CLAUDE.md: added multi-machine lease medium awareness');
    run();
    const content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(content.match(/### Multi-machine lease medium/g)).toHaveLength(1);
    expect(content).toContain('multiMachine.syncStatus.leaseMedium');
    expect(content).toContain('after a restart');
  });
});
