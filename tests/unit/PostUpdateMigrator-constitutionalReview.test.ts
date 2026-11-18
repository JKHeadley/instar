import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { installBuiltinSkills } from '../../src/commands/init.js';
import { PROBLEM_FIRST_FEEDBACK_CLAUSE } from '../../src/data/builtinSkillContent.js';

describe('constitutional review delivery to existing agents', () => {
  let root = '';
  afterEach(() => { if (root) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'constitutional-review-migration-test:cleanup' }); });
  it('updates canonical and both renderings once, supplies support files, and preserves unrelated/custom text', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'constitutional-skill-migration-'));
    for (const prefix of ['.instar', '.claude', '.agents']) {
      for (const skill of ['instar-dev', 'feedback', 'instar-feedback', 'custom-skill']) {
        const dir = path.join(root, prefix, 'skills', skill); fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${skill}\ndescription: fixture\n---\n${skill === 'instar-dev' ? '# /instar-dev' : skill === 'feedback' ? '# /feedback' : skill === 'instar-feedback' ? '# instar-feedback' : '# Custom'}\n\nKeep this local customization.\n`);
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
      expect(fs.readFileSync(path.join(root, prefix, 'skills/feedback/SKILL.md'), 'utf8')).toContain(PROBLEM_FIRST_FEEDBACK_CLAUSE);
      expect(fs.readFileSync(path.join(root, prefix, 'skills/custom-skill/SKILL.md'), 'utf8')).not.toContain('INSTAR:');
    }
  });

  it('the actual fresh feedback installer and existing feedback upgrade receive the same clause', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'constitutional-feedback-installer-'));
    installBuiltinSkills(path.join(root, '.claude/skills'), 4042);
    const canonical = path.join(root, '.instar/skills/feedback/SKILL.md');
    const emitted = fs.readFileSync(canonical, 'utf8');
    expect(emitted).toContain('# /feedback');
    expect(emitted).toContain(PROBLEM_FIRST_FEEDBACK_CLAUSE);
    expect(fs.readFileSync(path.join(root, '.claude/skills/feedback/SKILL.md'), 'utf8')).toContain(PROBLEM_FIRST_FEEDBACK_CLAUSE);
    expect(fs.readFileSync(path.join(process.cwd(), 'skills/instar-feedback/SKILL.md'), 'utf8')).toContain(PROBLEM_FIRST_FEEDBACK_CLAUSE);
    const roots = ['.instar', '.claude', '.agents'];
    const before = emitted.replace(PROBLEM_FIRST_FEEDBACK_CLAUSE, '') + '\nKeep owner customization.\n';
    for (const prefix of roots) {
      const file = path.join(root, prefix, 'skills/feedback/SKILL.md'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, before);
    }
    const migrator = new PostUpdateMigrator({ projectDir: root, stateDir: path.join(root, '.instar'), port: 4042, hasTelegram: false, projectName: 'fixture-agent' });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    const run = () => (migrator as any).migrateBugFixConstitutionalReview(result);
    run(); run();
    expect(result.errors).toEqual([]);
    for (const prefix of roots) {
      const content = fs.readFileSync(path.join(root, prefix, 'skills/feedback/SKILL.md'), 'utf8');
      expect(content).toContain('Keep owner customization.');
      expect(content.split('INSTAR:PROBLEM-FIRST-BUG-REPORTS')).toHaveLength(2);
    }
  });

  it.each(['write-trace-original.txt', 'write-trace-gate-install-check.txt'])('upgrades captured shipped %s after guidance exists, while preserving custom bytes', (fixture) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'constitutional-old-writer-'));
    const old = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/constitutional-review', fixture));
    const incoming = fs.readFileSync(path.join(process.cwd(), 'skills/instar-dev/scripts/write-trace.mjs'));
    const roots = ['.instar', '.claude', '.agents'];
    const writer = (prefix: string) => path.join(root, prefix, 'skills/instar-dev/scripts/write-trace.mjs');
    for (const prefix of roots) {
      fs.mkdirSync(path.dirname(writer(prefix)), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(path.dirname(writer(prefix))), 'SKILL.md'), '# /instar-dev\n<!-- INSTAR:ALL-TIER-CONSTITUTION-REVIEW -->\nKeep existing guidance and customization.\n');
      fs.writeFileSync(writer(prefix), old);
    }
    const migrator = new PostUpdateMigrator({ projectDir: root, stateDir: path.join(root, '.instar'), port: 4042, hasTelegram: false, projectName: 'fixture-agent' });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    const run = () => (migrator as any).migrateBugFixConstitutionalReview(result);
    run(); run();
    expect(result.errors).toEqual([]);
    for (const prefix of roots) expect(fs.readFileSync(writer(prefix))).toEqual(incoming);
    const customized = Buffer.concat([old, Buffer.from('\n// owner customization retained\n')]);
    for (const prefix of roots) fs.writeFileSync(writer(prefix), customized);
    run();
    for (const prefix of roots) expect(fs.readFileSync(writer(prefix))).toEqual(customized);
  });
});
