import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('verified display names reach new and existing agents', () => {
  it('adds the same rule once to an existing CLAUDE.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-verified-names-'));
    try {
      const file = path.join(dir, 'CLAUDE.md');
      fs.writeFileSync(file, '# Agent\n- List topics: `curl http://localhost:4042/telegram/topics`\n');
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agent\n');
      fs.writeFileSync(path.join(dir, 'GEMINI.md'), '# Agent\n');
      const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
      const run = () => (migrator as unknown as { migrateClaudeMd(r: { upgraded: string[]; skipped: string[]; errors: string[] }): void }).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
      run();
      const once = fs.readFileSync(file, 'utf8');
      expect(once).toContain('Find verified topic names across my machines:');
      expect(once).toContain('/telegram/topics?scope=pool');
      const shadow = (migrator as unknown as { migrateFrameworkShadowCapabilities(r: { upgraded: string[]; skipped: string[]; errors: string[] }): void });
      shadow.migrateFrameworkShadowCapabilities({ upgraded: [], skipped: [], errors: [] });
      expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('Find verified topic names across my machines:');
      expect(fs.readFileSync(path.join(dir, 'GEMINI.md'), 'utf8')).toContain('Find verified topic names across my machines:');
      run();
      expect(fs.readFileSync(file, 'utf8')).toBe(once);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-verifiedNames.test.ts:cleanup' });
    }
  });
});
