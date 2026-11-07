import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { failureCalloutAwareness } from '../../src/core/failureCalloutAwareness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('failure-callout awareness migration parity', () => {
  it('persists the missing section when all other migrations have already run, then is idempotent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-awareness-'));
    try {
      fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
      const file = path.join(root, 'CLAUDE.md');
      fs.writeFileSync(file, generateClaudeMd('test', 'Scout', 4042, true));
      const migrator = new PostUpdateMigrator({ projectDir: root, stateDir: path.join(root, '.instar'), port: 4042, hasTelegram: true, projectName: 'test' });
      const run = () => (migrator as any).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
      run(); run();
      const current = fs.readFileSync(file, 'utf8');
      expect(current).toContain(failureCalloutAwareness(4042));
      fs.writeFileSync(file, current.replace(failureCalloutAwareness(4042), ''));
      run();
      expect(fs.readFileSync(file, 'utf8')).toContain(failureCalloutAwareness(4042));
      const once = fs.readFileSync(file, 'utf8'); run();
      expect(fs.readFileSync(file, 'utf8')).toBe(once);
    } finally { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'failure-awareness-test' }); }
  });
});
