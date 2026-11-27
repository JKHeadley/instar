import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error — plain ESM script without type declarations
import { parseNameStatusZ, uxCheckFromExit, lintDescription, renderReport, uxApostropheHint, prNumbersFromRun, statusFor, consequenceOf } from '../../scripts/pr-description-lint.mjs';
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
    expect(report.summary).toContain('would be refused if merged as it stands now');
  });
  it('never describes a UX-only failure as a safe-merge refusal', () => {
    const ux = { name: 'ux-impact', ok: false, detail: 'UX Impact section is required for user-facing paths' };
    const report = renderReport({ checks: [{ name: 'eli16', ok: true }, ux], failing: [ux] });
    expect(report.annotations[0]).toContain('the UX impact gate fails on this');
    expect(report.annotations.join('\n')).not.toContain('safe-merge');
    expect(report.summary).not.toMatch(/would be refused if merged/);
    expect(report.summary).toContain('its own gate, not a safe-merge check');
    expect(report.summary).toContain('snapshot of this pull request as of this event');
  });
  it('says all pass when nothing fails', () => {
    expect(renderReport({ checks: [{ name: 'eli16', ok: true }], failing: [] }).summary).toContain('All description checks pass.');
  });
});

describe('the commit status is always success and names what would be refused now', () => {
  it('posts success with the refusing safe-merge checks, and UX separately', () => {
    const st = statusFor({ failing: [{ name: 'eli16', ok: false }, { name: 'ux-impact', ok: false }] }, 'https://example.test/run');
    expect(st).toMatchObject({ state: 'success', context: 'description-early-warning', target_url: 'https://example.test/run' });
    expect(st.description).toContain('would be refused if merged as it stands now (eli16)');
    expect(st.description).toContain('UX Impact would fail its gate');
    expect(st.description.length).toBeLessThanOrEqual(140);
  });
  it('says pass when nothing fails, and never uses a failing state', () => {
    expect(statusFor({ failing: [] })).toEqual({ state: 'success', context: 'description-early-warning', description: 'Advisory: description checks pass' });
  });
  it('maps each check to the right gate', () => {
    expect(consequenceOf('eli16')).toContain('safe-merge');
    expect(consequenceOf('ux-impact')).not.toContain('safe-merge');
  });
});

describe('prNumbersFromRun', () => {
  it('reads numbers from the workflow_run pull_requests JSON and tolerates junk', () => {
    expect(prNumbersFromRun('[{"number":4010},{"number":4010},{"number":3767}]')).toEqual([4010, 3767]);
    expect(prNumbersFromRun('[]')).toEqual([]);
    expect(prNumbersFromRun('not json')).toEqual([]);
    expect(prNumbersFromRun(undefined)).toEqual([]);
  });
});

describe('the CLI never blocks', () => {
  it('exits 0 with a warning when it has no repository or token', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/pr-description-lint.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/::warning title=Description check could not run::GITHUB_REPOSITORY and GH_TOKEN are required/);
  });
  it('exits 0 and does nothing when the run carries no pull request', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/pr-description-lint.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'x', RUN_PULL_REQUESTS: '[]' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing to check');
  });
});

describe('the workflows: trusted from the default branch, any base, never a red row', () => {
  const trigger = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-description-lint-trigger.yml'), 'utf8');
  const lint = fs.readFileSync(path.join(ROOT, '.github/workflows/pr-description-lint.yml'), 'utf8');
  it('the trigger runs on every pull request, any base, with no permissions and no pull-request text', () => {
    expect(trigger).toMatch(/^on:\n {2}pull_request:\n {4}types: \[opened, edited, synchronize, reopened, ready_for_review\]\n/m);
    expect(trigger).not.toMatch(/^\s*branches:/m);
    expect(trigger).toMatch(/^permissions: \{\}\n/m);
    expect(trigger).not.toMatch(/\$\{\{/);
    expect(trigger).not.toMatch(/uses:/);
  });
  it('the check runs on workflow_run (always loaded from the default branch), never pull_request or pull_request_target', () => {
    expect(lint).toMatch(/^on:\n {2}workflow_run:\n {4}workflows: \["PR description lint trigger"\]\n {4}types: \[completed\]\n/m);
    expect(lint).not.toMatch(/^\s*pull_request(_target)?:/m);
    expect(trigger).toMatch(/^name: PR description lint trigger$/m);
  });
  it('has least privilege, no persisted credentials, and no pull-request text in any shell line', () => {
    expect(lint).toMatch(/^permissions:\n {2}contents: read\n {2}pull-requests: read\n {2}statuses: write\n/m);
    expect(lint).toMatch(/persist-credentials: false/);
    // No expression is ever interpolated into a shell line; event data reaches the script only through env.
    const runLines = lint.split('\n').filter((l) => /^\s*run:/.test(l));
    expect(runLines.length).toBe(1);
    for (const l of runLines) expect(l).not.toContain('${{');
    expect(lint).not.toMatch(/head_commit|display_title/);
    expect(lint).toMatch(/run: node scripts\/pr-description-lint\.mjs \|\| true$/m);
  });
  it('can never conclude failed: the job and every step are non-failing', () => {
    expect(lint).toMatch(/^ {4}continue-on-error: true$/m);
    const steps = lint.split('\n      - ').slice(1);
    expect(steps.length).toBe(3);
    for (const step of steps) expect(step).toMatch(/continue-on-error: true/);
  });
});
