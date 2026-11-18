import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('constitutional review delivery to existing agents', () => {
  let root = '';
  afterEach(() => { if (root) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'constitutional-review-migration-test:cleanup' }); });
  it('updates canonical and both renderings once, supplies support files, and preserves unrelated/custom text', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'constitutional-skill-migration-'));
    for (const prefix of ['.instar', '.claude', '.agents']) {
      for (const skill of ['instar-dev', 'instar-feedback', 'custom-skill']) {
        const dir = path.join(root, prefix, 'skills', skill); fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${skill}\ndescription: fixture\n---\n${skill === 'instar-dev' ? '# /instar-dev' : skill === 'instar-feedback' ? '# instar-feedback' : '# Custom'}\n\nKeep this local customization.\n`);
      }
    }
    const migrator = new PostUpdateMigrator({ projectDir: root, stateDir: path.join(root, '.instar'), port: 4042, hasTelegram: false, projectName: 'fixture-agent' });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    const run = () => (migrator as any).migrateBugFixConstitutionalReview(result);
    run(); const once = fs.readFileSync(path.join(root, '.agents/skills/instar-dev/SKILL.md'), 'utf8'); run();
    expect(result.errors).toEqual([]);
    expect(fs.readFileSync(path.join(root, '.agents/skills/instar-dev/SKILL.md'), 'utf8')).toBe(once);
    for (const prefix of ['.instar', '.claude', '.agents']) {
      const dev = path.join(root, prefix, 'skills/instar-dev');
      expect(fs.readFileSync(path.join(dev, 'SKILL.md'), 'utf8')).toContain('Keep this local customization.');
      expect(fs.readFileSync(path.join(dev, 'scripts/constitutional-review.mjs'), 'utf8')).toContain('prepareConstitutionReview');
      expect(fs.readFileSync(path.join(dev, 'scripts/write-trace.mjs'), 'utf8')).toContain('constitutionalReview');
      expect(fs.readFileSync(path.join(root, prefix, 'skills/instar-feedback/SKILL.md'), 'utf8')).toContain('INSTAR:PROBLEM-FIRST-BUG-REPORTS');
      expect(fs.readFileSync(path.join(root, prefix, 'skills/custom-skill/SKILL.md'), 'utf8')).not.toContain('INSTAR:');
    }
  });
});
