// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// The Substrate family's admission rule: a new article states how it passes the three tests.
const LINT = path.resolve('scripts/lint-substrate-admission-declared.mjs');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'lint-substrate-admission-declared.test.ts' }); });

const FULL = '**Admission.** test 1: a fact about the model. test 2: looks the same from outside. test 3: surfaced by self-report.';
function run(articles: Array<{ title: string; body?: string }>, baseline: unknown = { articlesWithoutAdmissionLine: [] }, after: string[] = []): { code: number; out: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-admission-')));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const reg = ['# Standards', '', '## Building', '', '### Elsewhere', '**Rule.** Not in the family.', '',
    '## The Substrate — the model-level truths', '', 'Intro.', '',
    ...articles.flatMap((a) => [`### ${a.title}`, '**Rule.** A rule.', ...(a.body ? [a.body] : []), '']),
    '## Interaction', '', ...after.flatMap((t) => [`### ${t}`, '**Rule.** x.', ''])].join('\n');
  fs.writeFileSync(path.join(root, 'docs/STANDARDS-REGISTRY.md'), reg);
  if (baseline !== null) fs.writeFileSync(path.join(root, 'docs/substrate-admission-baseline.json'), typeof baseline === 'string' ? baseline : JSON.stringify(baseline));
  const r = spawnSync(process.execPath, [LINT], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}

describe('lint-substrate-admission-declared', () => {
  it('passes a new article whose Admission line addresses all three tests', () => {
    const r = run([{ title: 'Model Truth', body: FULL }]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 article(s) in The Substrate: 1 with an Admission line, 0 read by the 2026-11-27 sweep');
  });

  it('fails a new article with no Admission line, naming it', () => {
    const r = run([{ title: 'Engineering Habit' }]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('*Engineering Habit* is filed in The Substrate with no "**Admission.**" line');
  });

  it('fails an Admission line that skips a test', () => {
    const r = run([{ title: 'Half Argued', body: '**Admission.** test 1: about the model. test 2: invisible.' }]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('does not address all three tests');
  });

  it('passes a baselined article, and ignores articles outside the section', () => {
    const r = run([{ title: 'Swept Article' }], { articlesWithoutAdmissionLine: ['Swept Article'] }, ['Interaction Article']);
    expect(r.code).toBe(0);
  });

  it('a baselined article that gains an Admission line must leave the baseline', () => {
    const r = run([{ title: 'Swept Article', body: FULL }], { articlesWithoutAdmissionLine: ['Swept Article'] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('now carries an Admission line: remove it from the baseline');
  });

  it('a baseline entry for an article no longer in the family is stale and fails', () => {
    const r = run([{ title: 'Kept', body: FULL }], { articlesWithoutAdmissionLine: ['Moved To Building'] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('baseline entry "Moved To Building" is no longer an article in The Substrate');
  });

  it('fails loudly on a missing, corrupt or malformed baseline', () => {
    for (const [b, msg] of [[null, 'missing or not JSON'], ['{nope', 'missing or not JSON'], [{ other: [] }, 'the baseline must be']] as const) {
      const r = run([{ title: 'A', body: FULL }], b);
      expect(r.code).toBe(1);
      expect(r.out).toContain(msg);
    }
  });

  it('fails loudly when the section heading is renamed', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-admission-')));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/STANDARDS-REGISTRY.md'), '# S\n\n## Substrates\n\n### A\n**Rule.** r.\n');
    fs.writeFileSync(path.join(root, 'docs/substrate-admission-baseline.json'), JSON.stringify({ articlesWithoutAdmissionLine: [] }));
    const r = spawnSync(process.execPath, [LINT], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no "## The Substrate" section');
  });

  it('counts indented and tab-separated headings, ignores headings in code blocks, and stops at a level-1 heading', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-admission-')));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/STANDARDS-REGISTRY.md'), [
      '# S', '', '## The Substrate — truths', '',
      '   ### Indented One', '**Rule.** r.', '',
      '###\tTabbed One', '**Rule.** r.', '',
      '```', '### Not A Heading', '## Not The End', '```', '',
      '# Elsewhere', '', '### After Level One', '**Rule.** r.', '',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'docs/substrate-admission-baseline.json'), JSON.stringify({ articlesWithoutAdmissionLine: [] }));
    const r = spawnSync(process.execPath, [LINT], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('*Indented One* is filed in The Substrate');
    expect(r.stderr).toContain('*Tabbed One* is filed in The Substrate');
    expect(r.stderr).not.toContain('Not A Heading');
    expect(r.stderr).not.toContain('After Level One');
    expect(r.stderr).toContain('2 article(s) in The Substrate');
  });

  it('does not take "test 10" for test 1', () => {
    const r = run([{ title: 'Near Miss', body: '**Admission.** test 10: x. test 2: y. test 3: z.' }]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('does not address all three tests');
  });
});
