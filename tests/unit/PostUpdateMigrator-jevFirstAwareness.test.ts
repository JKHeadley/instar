import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd, jevFirstDecisionAwareness } from '../../src/scaffold/templates.js';

describe('Jev-first agent awareness migration', () => {
  it('renders the same card on new agents and idempotently adds it to old agents', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-jev-first-awareness-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir);
    const file = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Agent\n');
    try {
      const card = jevFirstDecisionAwareness(4042).trim();
      expect(generateClaudeMd('test', 'Test', 4042, false)).toContain(card);
      const migrator = new PostUpdateMigrator({ projectDir, stateDir, port: 4042,
        hasTelegram: false, projectName: 'test' });
      const migrate = () => (migrator as unknown as { migrateClaudeMd(r: { upgraded: string[]; skipped: string[]; errors: string[] }): void })
        .migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
      migrate();
      const first = fs.readFileSync(file, 'utf8');
      expect(first).toContain(card);
      migrate();
      expect(fs.readFileSync(file, 'utf8')).toBe(first);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true,
        operation: 'tests/unit/PostUpdateMigrator-jevFirstAwareness.test.ts' });
    }
  });
});
