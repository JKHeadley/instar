import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error — plain ESM script without type declarations
import { parseNameStatusZ, uxCheckFromExit, lintDescription, renderReport, uxApostropheHint } from '../../scripts/pr-description-lint.mjs';
// @ts-expect-error — plain ESM script without type declarations
import { runLocalBodyChecks } from '../../scripts/safe-merge.mjs';

const ROOT = path.resolve(__dirname, '../..');
const GOOD_ELI16 = '## ELI16\n\n' + 'This change makes the description check run when a pull request is opened, on any base, so a missing section is found before a test run is spent rather than at merge time. '.repeat(2) + '\n\n## Other\n';

describe('parseNameStatusZ', () => {
  it('maps git letters to GitHub statuses and keeps the new path of a rename', () => {
    const z = ['M', 'src/a.ts', 'A', 'docs/b.md', 'D', 'old.txt', 'R100', 'x/old.ts', 'x/new.ts', ''].join('\0');
    expect(parseNameStatusZ(z)).toEqual([
      { filename: 'src/a.ts', status: 'modified' },
      { filename: 'docs/b.md', status: 'added' },
      { filename: 'old.txt', status: 'removed' },
      { filename: 'x/new.ts', status: 'renamed' },
    ]);
  });
  it('returns nothing for empty output', () => {
    expect(parseNameStatusZ('')).toEqual([]);
  });
});

describe('uxCheckFromExit', () => {
  it('passes on 0, fails on 1 with the lint message, and never fails on an internal error', () => {
    expect(uxCheckFromExit(0, '')).toEqual({ name: 'ux-impact', ok: true });
    expect(uxCheckFromExit(1, '::error::UX Impact section is required for user-facing paths\n')).toEqual({ name: 'ux-impact', ok: false, detail: 'UX Impact section is required for user-facing paths' });
    expect(uxCheckFromExit(2, 'boom')).toMatchObject({ name: 'ux-impact', ok: true, unmeasured: true });
  });
});

describe('uxApostropheHint', () => {
  it('names the apostrophe and where it is inside the UX Impact section', () => {
    const body = "## ELI16\nx\n\n## UX Impact\n- Who sees this: owners.\n- First contact: the \"A document's settings\" screen.\n\n## Tests\nDon't care here.";
    const hint = uxApostropheHint(body);
    expect(hint).toContain("apostrophe (')");
    expect(hint).toContain('line 2 of the UX Impact section');
    expect(hint).not.toContain("Don't");
  });
  it('says nothing when the section has no apostrophe', () => {
    expect(uxApostropheHint('## UX Impact\n- Who sees this: owners.\n')).toBe('');
  });
});

describe('lintDescription uses the merge-time body checks unchanged', () => {
  const docsOnly = [{ filename: 'docs/notes.md', status: 'modified' }];
  it('gives exactly safe-merge runLocalBodyChecks verdicts (same names, same ok) for a passing description', () => {
    const input = { title: 'docs: notes', body: GOOD_ELI16, authorLogin: 'someone', authorType: 'User', files: docsOnly, decisionRecords: [] };
    const merge = runLocalBodyChecks(input);
    const { checks, failing } = lintDescription(input);
    expect(checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok])).toEqual(merge.map((c: { name: string; ok: boolean }) => [c.name, c.ok]));
    expect(failing).toEqual([]);
  });
  it('flags a missing ELI16 section, as the merge-time floor would refuse it', () => {
    const input = { title: 'fix: thing', body: 'No sections here.', authorLogin: 'someone', authorType: 'User', files: docsOnly, decisionRecords: [] };
    const merge = runLocalBodyChecks(input).find((c: { name: string }) => c.name === 'eli16');
    expect(merge.ok).toBe(false);
    const { failing } = lintDescription(input);
    expect(failing.map((c: { name: string }) => c.name)).toContain('eli16');
  });
  it('adds the UX check row and reports its failure', () => {
    const { failing, checks } = lintDescription({ title: 't', body: GOOD_ELI16, authorLogin: 'a', authorType: 'User', files: docsOnly, decisionRecords: [], uxCheck: { name: 'ux-impact', ok: false, detail: 'missing' } });
    expect(checks.at(-1)).toMatchObject({ name: 'ux-impact' });
    expect(failing.map((c: { name: string }) => c.name)).toEqual(['ux-impact']);
  });
});

describe('renderReport', () => {
  it('writes one warning annotation per failing check and never an error', () => {
    const report = renderReport({ checks: [{ name: 'eli16', ok: false, detail: 'no-eli16-heading' }, { name: 'decision-audit', ok: true }], failing: [{ name: 'eli16', ok: false, detail: 'no-eli16-heading' }] }, { baseRef: 'topic/x' });
    expect(report.annotations).toHaveLength(1);
    expect(report.annotations[0]).toMatch(/^::warning title=Description check: eli16::no-eli16-heading/);
    expect(report.annotations.join('\n')).not.toMatch(/::error/);
    expect(report.summary).toContain('`topic/x`');
    expect(report.summary).toContain('1 check(s) would refuse');
  });
  it('says all pass when nothing fails', () => {
    expect(renderReport({ checks: [{ name: 'eli16', ok: true }], failing: [] }).summary).toContain('All description checks pass.');
  });
});

describe('the CLI never blocks', () => {
  it('exits 0 with a warning when it cannot read its inputs', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/pr-description-lint.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/::warning title=Description check could not run::BASE_SHA and HEAD_SHA are required/);
  });
});

describe('the workflow is an early warning on every base, never a gate', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-description-lint.yml'), 'utf8');
  it('runs on pull_request with no branch filter and never on pull_request_target', () => {
    expect(yml).toMatch(/^on:\n {2}pull_request:\n {4}types: \[opened, edited, synchronize, reopened, ready_for_review\]\n/m);
    expect(yml).not.toMatch(/^\s*branches:/m);
    expect(yml).not.toMatch(/^\s*pull_request_target:/m);
  });
  it('is read-only, cannot fail the pull request, and runs the checker from the default branch', () => {
    expect(yml).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(yml).toMatch(/continue-on-error: true/);
    expect(yml).toMatch(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    expect(yml).toMatch(/run: node scripts\/pr-description-lint\.mjs/);
  });
});
