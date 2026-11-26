// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * Approval only where required — instruction text and its migration
 * (Echo Bugs topic 10000002791, spec docs/specs/approval-asks-only-where-required.md).
 *
 * The founding case: a build session told the operator "the repository only counts
 * a GitHub approval from someone other than the account that pushed it" because the
 * instar-dev skill still described a ruleset setting removed months earlier, and
 * both skills called approval "the user's step". Covered here:
 *  - the bundled skills carry every new sentence and none of the old ones;
 *  - the migration replaces only those sentences in the canonical copy and both
 *    renderings, re-stamps an in-sync rendering, keeps unrelated edits, reports a
 *    customized sentence, and is idempotent;
 *  - the core "PR links ask for the review" section: template and migration text
 *    are equal, and a full-layout CLAUDE.md is reworded in place once.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPROVAL_WHERE_REQUIRED_SKILL_TEXT, applySkillSentenceChanges } from '../../src/core/approvalWhereRequiredSkillText.js';
import {
  PostUpdateMigrator, skillBodyHash, PR_LINK_REVIEW_SECTION_BODY, PR_LINK_REVIEW_SECTION_BODY_V1,
} from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO = path.resolve(__dirname, '..', '..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/approval-where-required-skill-text.test.ts' });
});

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const run = (projectDir: string): Result => {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: Result = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateApprovalWhereRequired(r: Result): void }).migrateApprovalWhereRequired(result);
  return result;
};

/** The stock pre-change text of a bundled skill: every `next` turned back into its `prior`. */
function priorText(skill: string): string {
  let text = fs.readFileSync(path.join(REPO, 'skills', skill, 'SKILL.md'), 'utf8');
  const entry = APPROVAL_WHERE_REQUIRED_SKILL_TEXT.find((e) => e.skill === skill)!;
  for (const c of entry.changes) text = text.split(c.next).join(c.prior);
  return text;
}
const stamp = (raw: string, hash: string) => raw.replace(/^(---\n[\s\S]*?)(\n---\n)/, `$1\nx-instar-stamp: ${hash}$2`);

describe('bundled skills', () => {
  for (const entry of APPROVAL_WHERE_REQUIRED_SKILL_TEXT) {
    it(`${entry.skill}: every new sentence present, no old one left`, () => {
      const text = fs.readFileSync(path.join(REPO, 'skills', entry.skill, 'SKILL.md'), 'utf8');
      for (const c of entry.changes) {
        expect(text).toContain(c.next);
        expect(text).not.toContain(c.prior);
      }
    });
  }

  it('instar-dev no longer states the removed ruleset setting as in force', () => {
    const text = fs.readFileSync(path.join(REPO, 'skills', 'instar-dev', 'SKILL.md'), 'utf8');
    expect(text).not.toMatch(/in force on `JKHeadley\/instar` since 2026-08-22/);
    expect(text).toContain('read live, never remembered');
  });
});

describe('migrateApprovalWhereRequired', () => {
  function home(skill: string, opts: { canonical?: boolean; edit?: (s: string) => string } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-approval-text-')); dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    let stock = priorText(skill);
    if (opts.edit) stock = opts.edit(stock);
    const hash = skillBodyHash(stock)!;
    const files = {
      canonical: path.join(dir, '.instar', 'skills', skill, 'SKILL.md'),
      claude: path.join(dir, '.claude', 'skills', skill, 'SKILL.md'),
      agents: path.join(dir, '.agents', 'skills', skill, 'SKILL.md'),
    };
    if (opts.canonical !== false) { fs.mkdirSync(path.dirname(files.canonical), { recursive: true }); fs.writeFileSync(files.canonical, stock); }
    for (const f of [files.claude, files.agents]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, stamp(stock, hash)); }
    return { dir, files, hash };
  }

  for (const entry of APPROVAL_WHERE_REQUIRED_SKILL_TEXT) {
    it(`${entry.skill}: replaces the sentences everywhere and re-stamps in-sync renderings`, () => {
      const h = home(entry.skill);
      const r = run(h.dir);
      expect(r.errors).toEqual([]);
      const canonical = fs.readFileSync(h.files.canonical, 'utf8');
      const newHash = skillBodyHash(canonical)!;
      expect(newHash).not.toBe(h.hash);
      for (const f of [h.files.canonical, h.files.claude, h.files.agents]) {
        const text = fs.readFileSync(f, 'utf8');
        for (const c of entry.changes) { expect(text).toContain(c.next); expect(text).not.toContain(c.prior); }
      }
      for (const f of [h.files.claude, h.files.agents]) {
        const text = fs.readFileSync(f, 'utf8');
        expect(text).toContain(`x-instar-stamp: ${newHash}`);
        expect(skillBodyHash(text)).toBe(newHash);
      }
      // Idempotent: a second run changes nothing.
      const before = [h.files.canonical, h.files.claude, h.files.agents].map((f) => fs.readFileSync(f, 'utf8'));
      const again = run(h.dir);
      expect(again.upgraded).toEqual([]);
      expect([h.files.canonical, h.files.claude, h.files.agents].map((f) => fs.readFileSync(f, 'utf8'))).toEqual(before);
    });
  }

  it('keeps unrelated edits and reports a customized sentence instead of guessing', () => {
    const entry = APPROVAL_WHERE_REQUIRED_SKILL_TEXT.find((e) => e.skill === 'spec-converge')!;
    const customized = entry.changes[0].prior;
    const h = home('spec-converge', { edit: (s) => s.replace(customized, '2. Our own approval rule, written by this team.') + '\nA local note the agent added.\n' });
    const r = run(h.dir);
    const text = fs.readFileSync(h.files.claude, 'utf8');
    expect(text).toContain('2. Our own approval rule, written by this team.');
    expect(text).toContain('A local note the agent added.');
    for (const c of entry.changes.slice(1)) expect(text).toContain(c.next);
    expect(r.skipped.some((l) => l.includes('customized, 1 approval sentence'))).toBe(true);
  });

  it('a home with no canonical copy still has its renderings reworded, stamps untouched', () => {
    const h = home('instar-dev', { canonical: false });
    run(h.dir);
    const text = fs.readFileSync(h.files.claude, 'utf8');
    expect(text).toContain('read live, never remembered');
    expect(text).toContain(`x-instar-stamp: ${h.hash}`);
  });

  it('applySkillSentenceChanges counts a sentence already in its new form as done', () => {
    const c = [{ prior: 'old words', next: 'new words' }];
    expect(applySkillSentenceChanges('x new words y', c)).toEqual({ text: 'x new words y', changed: 0, missing: [] });
    expect(applySkillSentenceChanges('x other y', c).missing).toHaveLength(1);
  });
});

describe('the PR-links core section', () => {
  it('the template emits exactly the migration body', () => {
    expect(generateClaudeMd('test', 'Test', 4042, false)).toContain(PR_LINK_REVIEW_SECTION_BODY);
  });

  it('a full-layout CLAUDE.md with the first version is reworded in place, once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pr-link-v2-')); dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir);
    const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir, port: 4042, hasTelegram: false, projectName: 'test' });
    const patch = (c: string) => (migrator as unknown as { patchClaudeMdContent(c: string, r: Result): { content: string; patched: boolean } })
      .patchClaudeMdContent(c, { upgraded: [], skipped: [], errors: [] });
    const v1 = `# Agent\n\n## PR links ask for the review on GitHub too\n\n${PR_LINK_REVIEW_SECTION_BODY_V1}\n`;
    const once = patch(v1).content;
    expect(once).toContain(PR_LINK_REVIEW_SECTION_BODY);
    expect(once).not.toContain(PR_LINK_REVIEW_SECTION_BODY_V1);
    expect(once.split('## PR links ask for the review on GitHub too').length).toBe(2);
    expect(patch(once).content).toBe(once);
  });
});

describe('migrateApprovalWhereRequired — a user-edited rendering stays protected', () => {
  it('re-stamps to the new canonical hash even when the rendering body differs, so it still reads as a user edit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-approval-useredit-')); dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const stock = priorText('instar-dev');
    const oldHash = skillBodyHash(stock)!;
    const canonical = path.join(dir, '.instar', 'skills', 'instar-dev', 'SKILL.md');
    const claude = path.join(dir, '.claude', 'skills', 'instar-dev', 'SKILL.md');
    fs.mkdirSync(path.dirname(canonical), { recursive: true }); fs.writeFileSync(canonical, stock);
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, stamp(stock + '\nThe user added this line.\n', oldHash));
    run(dir);
    const newHash = skillBodyHash(fs.readFileSync(canonical, 'utf8'))!;
    const text = fs.readFileSync(claude, 'utf8');
    expect(text).toContain('The user added this line.');
    expect(text).toContain(`x-instar-stamp: ${newHash}`);
    // Body differs from the stamp → the parity rule sees a user edit and refuses to re-render it.
    expect(skillBodyHash(text)).not.toBe(newHash);
  });
});
