import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MARKER = '<!-- INSTAR:CONFORMANCE_NOT_CHECKED -->';
const roots = ['.instar', '.claude', '.agents'];
let home: string;
const beforeSkill = '---\nname: spec-converge\ndescription: Review specs\n---\n# /spec-converge\n\n**Internal reviewers (Claude subagents):**\n\n- **Lessons-aware.** Existing review.\n\n**The lessons-aware reviewer is not optional**, even in abbreviated convergence.\n\nLocal instruction to preserve.\n';
function seed(root: string, text = beforeSkill) {
  const dir = path.join(home, root, 'skills/spec-converge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  return dir;
}
function update() {
  const m = new PostUpdateMigrator({ projectDir: home, stateDir: path.join(home, '.instar'), port: 4042, hasTelegram: false, projectName: 'not-checked-test' });
  for (const name of Object.getOwnPropertyNames(PostUpdateMigrator.prototype)) {
    if (name.startsWith('migrate') && !['migrate', 'migrateSpecConformanceNotChecked'].includes(name)) vi.spyOn(m as any, name).mockImplementation(() => {});
  }
  return m.migrate();
}
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-not-checked-')); });
afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/spec-not-checked-cleanup' }); });

describe('the "not checked is not 0 flags" rule reaches installed spec-converge copies', () => {
  it('the bundled skill carries the block exactly once, before the lessons-aware anchor', () => {
    const bundled = fs.readFileSync(path.resolve('skills/spec-converge/SKILL.md'), 'utf8');
    expect(bundled.split(MARKER).length - 1).toBe(1);
    expect(bundled.indexOf(MARKER)).toBeLessThan(bundled.indexOf('**The lessons-aware reviewer is not optional**'));
    expect(bundled).toContain('never as `ran (0 flags)`');
  });

  it('inserts the block into canonical, Claude and Codex copies and preserves surrounding text', () => {
    const dirs = roots.map((r) => seed(r));
    const result = update();
    expect(result.errors.filter((x) => x.includes('not-checked'))).toEqual([]);
    for (const dir of dirs) {
      const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      expect(skill.split(MARKER).length - 1).toBe(1);
      expect(skill).toContain('Local instruction to preserve.');
      expect(skill.indexOf(MARKER)).toBeLessThan(skill.indexOf('**The lessons-aware reviewer is not optional**'));
    }
  });

  it('is idempotent', () => {
    const dir = seed('.agents');
    update();
    const first = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    update();
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe(first);
  });

  it('leaves a copy with no anchor unchanged and reports it', () => {
    const text = beforeSkill.replace('**The lessons-aware reviewer is not optional**', 'My own review note');
    const dir = seed('.agents', text);
    const result = update();
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe(text);
    expect(result.skipped.some((x) => x.includes('not-checked') && x.includes('anchor'))).toBe(true);
  });

  it('does not touch a custom skill that is not spec-converge', () => {
    const file = path.join(home, '.agents/skills/my-review/SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, beforeSkill);
    update();
    expect(fs.readFileSync(file, 'utf8')).toBe(beforeSkill);
  });
});
