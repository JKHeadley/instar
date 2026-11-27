import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { installBundledDevSkills } from '../../src/commands/init.js';
import { skillParityRule } from '../../src/providers/parity/rules/skillParityRule.js';

const MARKER = 'INSTAR:SPEC_EXPERIENCE_REVIEW';
const roots = ['.instar', '.claude', '.agents'];
const source = path.resolve('skills/spec-converge');
let home: string;
let external: string | null = null;
const beforeSkill = '---\nname: spec-converge\ndescription: Review specs\n---\n# /spec-converge\n\n**Internal reviewers (Claude subagents):**\n\n- **Lessons-aware.** Existing review.\n\n**External reviewers (cross-model):**\n\nLocal instruction to preserve.\n';
function seed(root: string, text = beforeSkill) {
  const dir = path.join(home, root, 'skills/spec-converge');
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  for (const name of ['reviewer-lessons-aware.md', 'report.md']) fs.writeFileSync(path.join(dir, 'templates', name), 'An old shipped template.\n');
  return dir;
}
function migrator() { return new PostUpdateMigrator({ projectDir: home, stateDir: path.join(home, '.instar'), port: 4042, hasTelegram: false, projectName: 'experience-test' }); }
function update() {
  const m = migrator();
  // Exercise the real public ordering, isolating unrelated migrations (some inspect host services).
  for (const name of Object.getOwnPropertyNames(PostUpdateMigrator.prototype)) {
    if (name.startsWith('migrate') && !['migrate', 'migrateFeatureMaturationGate', 'migrateSpecExperienceReview'].includes(name)) vi.spyOn(m as any, name).mockImplementation(() => {});
  }
  return m.migrate();
}
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-experience-')); });
afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/spec-experience-cleanup' }); if (external) SafeFsExecutor.safeRmSync(external, { recursive: true, force: true, operation: 'tests/spec-experience-external-cleanup' }); external = null; });

describe('experience review is delivered through the production update path', () => {
  it('updates existing canonical, Claude and Codex copies and preserves surrounding skill text', () => {
    const dirs = roots.map(r => seed(r));
    const result = update();
    expect(result.errors.filter(x => x.includes('experience'))).toEqual([]);
    for (const dir of dirs) {
      const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      expect(skill).toContain(MARKER);
      expect(skill).toContain('Local instruction to preserve.');
      for (const name of ['reviewer-lessons-aware.md', 'report.md']) expect(fs.readFileSync(path.join(dir, 'templates', name), 'utf8')).toBe(fs.readFileSync(path.join(source, 'templates', name), 'utf8'));
    }
  });
  it('refreshes the routine Codex policy loader in every installed default skill and preserves custom skills', () => {
    for (const root of roots) {
      const dir = seed(root); fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'scripts/cross-model-review.mjs'), 'old shipped loader');
    }
    const custom = path.join(home, '.agents/skills/custom-review/scripts/cross-model-review.mjs');
    fs.mkdirSync(path.dirname(custom), { recursive: true }); fs.writeFileSync(custom, 'custom loader');
    update(); update();
    for (const root of roots) {
      const actual = fs.readFileSync(path.join(home, root, 'skills/spec-converge/scripts/cross-model-review.mjs'), 'utf8');
      expect(actual).toBe(fs.readFileSync(path.join(source, 'scripts/cross-model-review.mjs'), 'utf8'));
      expect(actual).toContain('out.subscriptionPool = { routineCodexPlacement: cfg.subscriptionPool.routineCodexPlacement }');
    }
    expect(fs.readFileSync(custom, 'utf8')).toBe('custom loader');
  });
  it('is idempotent and keeps a backup of replaced shipped templates', () => {
    const dir = seed('.agents'); update();
    const first = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    update();
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe(first);
    expect((first.match(/<!-- INSTAR:SPEC_EXPERIENCE_REVIEW -->/g) || []).length).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'templates/report.md.pre-feature-maturation-v1.bak'), 'utf8')).toBe('An old shipped template.\n');
  });
  it('does not touch unrelated custom skill directories', () => {
    const file = path.join(home, '.agents/skills/my-custom-review/SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, beforeSkill);
    update(); expect(fs.readFileSync(file, 'utf8')).toBe(beforeSkill);
  });
  it.each(['missing', 'ambiguous'])('leaves a %s insertion anchor unchanged and reports it', kind => {
    const text = kind === 'missing' ? beforeSkill.replace('**External reviewers (cross-model):**', 'My review') : beforeSkill + '\n**External reviewers again:**\n';
    const dir = seed('.agents', text); const result = update();
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe(text);
    expect(result.skipped.some(x => x.includes('experience') && x.includes('anchor'))).toBe(true);
  });
  it('does not materialize an absent canonical or Codex skill as a template-only directory', () => {
    update();
    expect(fs.existsSync(path.join(home, '.instar/skills/spec-converge'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.agents/skills/spec-converge'))).toBe(false);
  });
  it('updates real normalized framework renderings without creating parity conflicts', async () => {
    installBundledDevSkills(path.join(home, '.instar/skills'));
    const canonical = path.join(home, '.instar/skills/spec-converge/SKILL.md');
    fs.writeFileSync(canonical, fs.readFileSync(canonical, 'utf8').replace(/<!-- INSTAR:SPEC_EXPERIENCE_REVIEW -->[\s\S]*?<!-- \/INSTAR:SPEC_EXPERIENCE_REVIEW -->\n\n/, ''));
    await skillParityRule.remediate(home, 'spec-converge', 'claude-code');
    await skillParityRule.remediate(home, 'spec-converge', 'codex-cli');
    update();
    const verdict = await skillParityRule.verify(home, 'spec-converge');
    expect(verdict.mismatches.filter(x => ['claude-code', 'codex-cli'].includes(x.framework))).toEqual([]);
    for (const root of roots) expect(fs.readFileSync(path.join(home, root, 'skills/spec-converge/SKILL.md'), 'utf8')).toContain(MARKER);
  });
  it.each(['appended instruction', 'missing anchor'])('preserves a customized rendering (%s) as a user-edit conflict across retries', async kind => {
    installBundledDevSkills(path.join(home, '.instar/skills'));
    const canonical = path.join(home, '.instar/skills/spec-converge/SKILL.md');
    fs.writeFileSync(canonical, fs.readFileSync(canonical, 'utf8').replace(/<!-- INSTAR:SPEC_EXPERIENCE_REVIEW -->[\s\S]*?<!-- \/INSTAR:SPEC_EXPERIENCE_REVIEW -->\n\n/, ''));
    await skillParityRule.remediate(home, 'spec-converge', 'codex-cli');
    const rendered = path.join(home, '.agents/skills/spec-converge/SKILL.md');
    fs.appendFileSync(rendered, '\nKeep my local review instruction.\n');
    if (kind === 'missing anchor') fs.writeFileSync(rendered, fs.readFileSync(rendered, 'utf8').replace('**External reviewers', '**My reviewers'));
    const priorCanonical = fs.readFileSync(canonical, 'utf8');
    const result = update(); update();
    expect(result.skipped.some(x => x.includes('user-edit conflict'))).toBe(true);
    expect(fs.readFileSync(canonical, 'utf8')).toBe(priorCanonical);
    expect(fs.readFileSync(rendered, 'utf8')).toContain('Keep my local review instruction.');
    const verdict = await skillParityRule.verify(home, 'spec-converge');
    expect(verdict.mismatches.filter(x => x.framework === 'codex-cli').map(x => x.reasonCode)).toEqual(['user-edit-conflict']);
  });
  it('does not advance renderings when the canonical write fails', async () => {
    installBundledDevSkills(path.join(home, '.instar/skills'));
    const canonical = path.join(home, '.instar/skills/spec-converge/SKILL.md');
    fs.writeFileSync(canonical, fs.readFileSync(canonical, 'utf8').replace(/<!-- INSTAR:SPEC_EXPERIENCE_REVIEW -->[\s\S]*?<!-- \/INSTAR:SPEC_EXPERIENCE_REVIEW -->\n\n/, ''));
    await skillParityRule.remediate(home, 'spec-converge', 'codex-cli');
    const rendered = path.join(home, '.agents/skills/spec-converge/SKILL.md');
    const before = fs.readFileSync(rendered, 'utf8');
    const write = SafeFsExecutor.atomicWriteFileSync.bind(SafeFsExecutor);
    vi.spyOn(SafeFsExecutor, 'atomicWriteFileSync').mockImplementation((file, ...args) => {
      if (file === canonical) throw new Error('injected canonical write failure');
      return write(file, ...args);
    });
    const result = update();
    expect(result.errors.some(x => x.includes('injected canonical write failure'))).toBe(true);
    expect(fs.readFileSync(rendered, 'utf8')).toBe(before);
    const verdict = await skillParityRule.verify(home, 'spec-converge');
    expect(verdict.mismatches.filter(x => x.framework === 'codex-cli')).toEqual([]);
  });
  it('repairs metadata on retry after the canonical lens has already been written', async () => {
    installBundledDevSkills(path.join(home, '.instar/skills'));
    const canonical = path.join(home, '.instar/skills/spec-converge/SKILL.md');
    const updated = fs.readFileSync(canonical, 'utf8');
    fs.writeFileSync(canonical, updated.replace(/<!-- INSTAR:SPEC_EXPERIENCE_REVIEW -->[\s\S]*?<!-- \/INSTAR:SPEC_EXPERIENCE_REVIEW -->\n\n/, ''));
    await skillParityRule.remediate(home, 'spec-converge', 'codex-cli');
    fs.writeFileSync(canonical, updated);
    update(); update();
    const verdict = await skillParityRule.verify(home, 'spec-converge');
    expect(verdict.mismatches.filter(x => x.framework === 'codex-cli')).toEqual([]);
  });
  it('reports an incomplete existing lens without duplicating or overwriting it', () => {
    const text = beforeSkill + '\n<!-- INSTAR:SPEC_EXPERIENCE_REVIEW -->\nunfinished local edit\n';
    const dir = seed('.agents', text); const result = update();
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe(text);
    expect(result.skipped.some(x => x.includes('experience') && x.includes('incomplete'))).toBe(true);
  });
  it('does not follow an external template-directory symlink', () => {
    const dir = seed('.agents');
    SafeFsExecutor.safeRmSync(path.join(dir, 'templates'), { recursive: true, force: true, operation: 'tests/spec-experience-symlink-setup' });
    external = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-experience-external-'));
    fs.writeFileSync(path.join(external, 'report.md'), 'outside content');
    fs.symlinkSync(external, path.join(dir, 'templates'), 'dir');
    const result = update();
    expect(fs.readFileSync(path.join(external, 'report.md'), 'utf8')).toBe('outside content');
    expect(result.skipped.some(x => x.includes('experience') && x.includes('external'))).toBe(true);
  });
  it('restores missing owned templates on an installed skill', () => {
    const dir = seed('.agents');
    SafeFsExecutor.safeUnlinkSync(path.join(dir, 'templates/report.md'), { operation: 'tests/spec-experience-missing-template' });
    update(); expect(fs.readFileSync(path.join(dir, 'templates/report.md'), 'utf8')).toContain('Experience fit');
  });
});

describe('the required reviewer receives the substantive lens', () => {
  it('loads current authority, tests both burden and overreach, and does not invent targets', () => {
    const text = fs.readFileSync(path.join(source, 'templates/reviewer-lessons-aware.md'), 'utf8');
    expect(text).toContain('### Q5. EXPERIENCE FIT');
    expect(text).toContain('Trust Is Earned by Work and Granted Only by the Person');
    expect(text).toContain('Intelligence Infers, Keywords Only Guard');
    expect(text).toContain('needless repeat asks');
    expect(text).toContain('coverage the record does not support');
    expect(text).toContain('not applicable');
    expect(text).toContain('Do not invent');
    expect(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8')).toContain(MARKER);
    expect(fs.readFileSync(path.join(source, 'templates/report.md'), 'utf8')).toContain('## Experience fit');
  });
});
