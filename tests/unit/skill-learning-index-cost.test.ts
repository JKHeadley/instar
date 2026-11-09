// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/**
 * IndexCost — §3.9 measured index size (Tier 1): real rendered descriptions under `.claude/skills` and
 * `.agents/skills`, the Claude loader budget + headroom, the unknown `.agents` limit, a missing layout, an
 * unreadable SKILL.md, and the prompt line.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  CLAUDE_SKILL_INDEX_BUDGET_ENV, CLAUDE_SKILL_INDEX_CHAR_BUDGET, claudeIndexBudgetChars, indexLineBytes, measureIndexCost, renderIndexCostLine, sanitiseDescription,
} from '../../src/monitoring/skillLearning/IndexCost.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/skill-learning-index-cost.test.ts' }); });

function home(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-index-cost-'));
  dirs.push(d);
  return d;
}
function skill(root: string, layout: string, name: string, description: string, raw?: string): void {
  fs.mkdirSync(path.join(root, layout, name), { recursive: true });
  fs.writeFileSync(path.join(root, layout, name, 'SKILL.md'), raw ?? `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  x-instar-stamp: "abc"\n---\n# ${name}\n\nbody text that is NOT indexed\n`);
}

describe('IndexCost — real sizes', () => {
  it('sums the sanitised `name: description` lines per layout; the body is never counted; Claude headroom against the 15 000-char budget; .agents limit unknown', () => {
    const root = home();
    skill(root, '.claude/skills', 'alpha', 'Use when alpha is asked. Not for beta.');
    skill(root, '.claude/skills', 'beta', 'Use  when\tbeta.\nNot for alpha.');          // whitespace collapses
    skill(root, '.agents/skills', 'alpha', 'Use when alpha is asked. Not for beta.');
    fs.mkdirSync(path.join(root, '.claude', 'skills', 'not-a-skill'));                 // a dir without SKILL.md is not a skill
    fs.writeFileSync(path.join(root, '.claude', 'skills', 'stray.txt'), 'x');           // files are ignored
    const r = measureIndexCost({ projectDir: root, env: {}, now: () => Date.parse('2026-11-06T12:00:00Z') });
    const alpha = indexLineBytes('alpha', 'Use when alpha is asked. Not for beta.');
    const beta = indexLineBytes('beta', 'Use when beta. Not for alpha.');
    expect(alpha).toBe(Buffer.byteLength('alpha: Use when alpha is asked. Not for beta.\n'));
    expect(beta).toBe(Buffer.byteLength('beta: Use when beta. Not for alpha.\n'));
    expect(r.at).toBe('2026-11-06T12:00:00.000Z');
    expect(r.layouts).toEqual([
      { layout: 'claude', dir: '.claude/skills', present: true, skills: 2, unreadable: 0, bytes: alpha + beta, limitChars: CLAUDE_SKILL_INDEX_CHAR_BUDGET, headroomChars: CLAUDE_SKILL_INDEX_CHAR_BUDGET - alpha - beta },
      { layout: 'agents', dir: '.agents/skills', present: true, skills: 1, unreadable: 0, bytes: alpha, limitChars: null, headroomChars: null },
    ]);
    expect(r.totalBytes).toBe(2 * alpha + beta);
    expect(r.totalSkills).toBe(3);
    expect(r.largestDescriptionBytes).toBe(Buffer.byteLength('Use when alpha is asked. Not for beta.'));
    expect(r.claudeHeadroomChars).toBe(CLAUDE_SKILL_INDEX_CHAR_BUDGET - alpha - beta);
    expect(r.claudeHeadroomTokens).toBe(Math.floor((CLAUDE_SKILL_INDEX_CHAR_BUDGET - alpha - beta) / 4));
  });

  it('a missing layout directory is present:false with zero skills — never an error; both missing ⇒ zero totals, full headroom', () => {
    const root = home();
    skill(root, '.agents/skills', 'only', 'Use when only. Not for others.');
    const r = measureIndexCost({ projectDir: root, env: {} });
    expect(r.layouts[0]).toMatchObject({ layout: 'claude', present: false, skills: 0, bytes: 0, headroomChars: CLAUDE_SKILL_INDEX_CHAR_BUDGET });
    expect(r.layouts[1]).toMatchObject({ layout: 'agents', present: true, skills: 1 });
    const empty = measureIndexCost({ projectDir: path.join(root, 'nowhere'), env: {} });
    expect(empty.totalBytes).toBe(0);
    expect(empty.totalSkills).toBe(0);
    expect(empty.largestDescriptionBytes).toBe(0);
    expect(empty.layouts.every((l) => !l.present)).toBe(true);
    expect(renderIndexCostLine(empty)).toContain('.claude/skills: absent (0 skills); .agents/skills: absent (0 skills)');
  });

  it('an unreadable SKILL.md is counted as unreadable, not as a skill and not as a crash; descriptions are capped at 256 like the parity rule', () => {
    const root = home();
    skill(root, '.claude/skills', 'broken', '', 'no frontmatter here');
    skill(root, '.claude/skills', 'long', 'x'.repeat(400));
    const r = measureIndexCost({ projectDir: root, env: {} });
    expect(r.layouts[0]).toMatchObject({ skills: 1, unreadable: 1 });
    expect(sanitiseDescription('x'.repeat(400))).toHaveLength(256);
    expect(sanitiseDescription('x'.repeat(400)).endsWith('...')).toBe(true);
    expect(r.layouts[0].bytes).toBe(indexLineBytes('long', 'x'.repeat(400)));
    expect(r.largestDescriptionBytes).toBe(256);
    expect(sanitiseDescription('a\u0000b  c\u007f')).toBe('a b c');
  });

  it('the Claude budget honours the loader env var; a bad value falls back to the default', () => {
    expect(claudeIndexBudgetChars({})).toBe(15_000);
    expect(claudeIndexBudgetChars({ [CLAUDE_SKILL_INDEX_BUDGET_ENV]: '20000' })).toBe(20_000);
    expect(claudeIndexBudgetChars({ [CLAUDE_SKILL_INDEX_BUDGET_ENV]: '0' })).toBe(15_000);
    expect(claudeIndexBudgetChars({ [CLAUDE_SKILL_INDEX_BUDGET_ENV]: 'lots' })).toBe(15_000);
    const root = home();
    skill(root, '.claude/skills', 'a', 'Use when a. Not for b.');
    const r = measureIndexCost({ projectDir: root, env: { [CLAUDE_SKILL_INDEX_BUDGET_ENV]: '100' } });
    expect(r.layouts[0].limitChars).toBe(100);
    expect(r.layouts[0].headroomChars).toBe(100 - indexLineBytes('a', 'Use when a. Not for b.'));
    // Over budget is reported as negative headroom, never clamped away.
    const r2 = measureIndexCost({ projectDir: root, env: { [CLAUDE_SKILL_INDEX_BUDGET_ENV]: '10' } });
    expect(r2.claudeHeadroomChars).toBeLessThan(0);
    expect(renderIndexCostLine(r2)).toContain(`headroom ${r2.claudeHeadroomChars}`);
  });

  it('renderIndexCostLine: the measured line, content-free, and the unmeasured line for null', () => {
    const root = home();
    skill(root, '.claude/skills', 'a', 'Use when a. Not for b.');
    const line = renderIndexCostLine(measureIndexCost({ projectDir: root, env: {} }));
    expect(line).toMatch(/^Measured skill index cost: \.claude\/skills: 1 skills, \d+ bytes of descriptions \(limit 15000 chars, headroom \d+\); \.agents\/skills: absent \(0 skills\)\. Claude index headroom ~\d+ tokens; largest description 22 bytes\. /);
    expect(line).not.toContain('Use when a');
    expect(line).toContain('no library count limit');
    expect(renderIndexCostLine(null)).toBe('Measured skill index cost: unmeasured this tick.');
  });
});
