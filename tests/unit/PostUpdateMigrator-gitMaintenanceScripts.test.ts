import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, type MigrationResult } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('PostUpdateMigrator — git maintenance scripts', () => {
  let projectDir = '';

  afterEach(() => {
    if (projectDir) {
      SafeFsExecutor.safeRmSync(projectDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/PostUpdateMigrator-gitMaintenanceScripts.test.ts cleanup',
      });
    }
  });

  it('installs fleet git maintenance scripts into .instar/scripts', () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-git-maint-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'scripts'), { recursive: true });

    const migrator = new PostUpdateMigrator({
      projectDir,
      stateDir,
      port: 4042,
      hasTelegram: false,
      projectName: 'test-agent',
    });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };

    (migrator as unknown as { migrateScripts(result: MigrationResult): void }).migrateScripts(result);

    expect(result.errors).toEqual([]);
    for (const filename of ['git-hygiene-classify.mjs', 'git-maintenance.mjs']) {
      const scriptPath = path.join(stateDir, 'scripts', filename);
      expect(fs.existsSync(scriptPath)).toBe(true);
      expect(fs.statSync(scriptPath).mode & 0o111).toBeGreaterThan(0);
      expect(result.upgraded).toContain(`scripts/${filename} (git hygiene maintenance)`);
    }
  });
});
