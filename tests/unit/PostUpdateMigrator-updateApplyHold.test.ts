import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PostUpdateMigrator, UPDATE_APPLY_VERIFY_HOLD_CLAUDEMD_LINE } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('manual update verify-hold awareness', () => {
  it('appears on fresh installs and is added exactly once to an existing agent', () => {
    expect(generateClaudeMd('test', 'Test', 4042, false)).toContain(UPDATE_APPLY_VERIFY_HOLD_CLAUDEMD_LINE);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-hold-awareness-'));
    try {
      fs.mkdirSync(path.join(dir, '.instar'));
      const file = path.join(dir, 'CLAUDE.md');
      fs.writeFileSync(file, '## Update Management\n- Apply: `POST /updates/apply`\n');
      const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
      const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
      const run = () => (migrator as unknown as { migrateClaudeMd(r: typeof result): void }).migrateClaudeMd(result);
      run();
      run();
      const updated = fs.readFileSync(file, 'utf8');
      expect(updated.split(UPDATE_APPLY_VERIFY_HOLD_CLAUDEMD_LINE)).toHaveLength(2);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-updateApplyHold.test.ts' });
    }
  });
});
