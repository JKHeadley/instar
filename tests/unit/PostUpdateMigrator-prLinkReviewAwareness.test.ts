import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

const HEADING = '## PR links ask for the review on GitHub too';

describe('PR-link reviewer awareness migration', () => {
  it('new agents get the section; old agents get it once, identical to the template', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pr-link-awareness-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir);
    const file = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Agent\n');
    try {
      const generated = generateClaudeMd('test', 'Test', 4042, false);
      expect(generated).toContain(HEADING);
      const section = generated.slice(generated.indexOf(HEADING), generated.indexOf('\n## ', generated.indexOf(HEADING) + 3)).trim();
      const migrator = new PostUpdateMigrator({ projectDir, stateDir, port: 4042, hasTelegram: false, projectName: 'test' });
      const migrate = () => (migrator as unknown as { migrateClaudeMd(r: { upgraded: string[]; skipped: string[]; errors: string[] }): void })
        .migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
      migrate();
      const first = fs.readFileSync(file, 'utf8');
      expect(first).toContain(section);
      migrate();
      expect(fs.readFileSync(file, 'utf8')).toBe(first);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true,
        operation: 'tests/unit/PostUpdateMigrator-prLinkReviewAwareness.test.ts' });
    }
  });
});
