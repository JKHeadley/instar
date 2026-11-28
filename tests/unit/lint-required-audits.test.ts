// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
// safe-git-allow: test file — git init/clone/commit/checkout only inside throwaway fixture repositories.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
// @ts-expect-error — .mjs script, no type declarations; runtime import is fine under vitest
import { isCalendarDate, readReport, matches, shapeProblems, snoozeProblems, rowState } from '../../scripts/lint-required-audits.mjs';

// The required-audits register closes STD-SUBCOUNTDOWN-audit-never-started: an audit that must
// recur is listed, one that never started or lapsed is named on every run without ever failing a
// commit for a date, and no row is quietly snoozed or removed (spec docs/specs/audit-never-started.md).

const SCRIPT = path.resolve('scripts/lint-required-audits.mjs');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'lint-required-audits.test.ts' }); });

type Row = Record<string, unknown>;
const row = (over: Row = {}): Row => ({ id: 'sec', scope: 'security review', owner: 'echo-x', cadenceDays: 30, firstDueBy: '2026-12-01', ...over });
const stamped = (audit: string, date: string, eol = '\n') => ['---', `audit: ${audit}`, `converged: "${date}T10:00:00.000Z"`, 'rounds: "2"', '---', '# report', ''].join(eol);

function fixture(register: unknown, reports: Record<string, string> = {}, base = os.tmpdir()) {
  const root = fs.mkdtempSync(path.join(base, 'required audits '));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'docs/audits'), { recursive: true });
  if (register !== undefined) fs.writeFileSync(path.join(root, 'docs/audits/required-audits.json'), typeof register === 'string' ? register : JSON.stringify(register));
  for (const [name, text] of Object.entries(reports)) fs.writeFileSync(path.join(root, 'docs/audits', name), text);
  return root;
}
const run = (root: string, ...extra: string[]) =>
  spawnSync('node', [SCRIPT, `--root=${root}`, '--main-register=none', ...extra], { encoding: 'utf8' });

describe('lint-required-audits: pure parts', () => {
  it('accepts only real calendar dates', () => {
    expect(isCalendarDate('2026-12-01')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-12-1')).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
  });

  it('reads frontmatter with LF or CRLF line endings, and leaves an unstamped report unstamped', () => {
    expect(readReport('a.md', stamped('sec', '2026-11-01'))).toMatchObject({ audit: 'sec', converged: '2026-11-01', slug: 'a' });
    expect(readReport('a.md', stamped('sec', '2026-11-01', '\r\n'))).toMatchObject({ audit: 'sec', converged: '2026-11-01' });
    expect(readReport('b.md', '# no frontmatter\n')).toMatchObject({ audit: null, converged: null, slug: 'b' });
    expect(readReport('c.md', '---\naudit: sec\nconverged: "not a date"\n---\n')).toMatchObject({ converged: null });
  });

  it('matches by declared id, else by file name, exactly or with a date suffix, and by listed report ids', () => {
    const r = row();
    expect(matches({ audit: 'sec', slug: 'other' }, r)).toBe(true);
    expect(matches({ audit: 'sec-2026-11-05', slug: 'other' }, r)).toBe(true);
    expect(matches({ audit: null, slug: 'sec' }, r)).toBe(true);
    expect(matches({ audit: null, slug: 'sec-2026-11-05' }, r)).toBe(true);
    // a prefix of another name is not a match
    expect(matches({ audit: null, slug: 'security-review' }, r)).toBe(false);
    expect(matches({ audit: null, slug: 'sec-extra-2026-11-05' }, r)).toBe(false);
    // a report that declares a different id is not claimed through its file name
    expect(matches({ audit: 'other', slug: 'sec-2026-11-05' }, r)).toBe(false);
    expect(matches({ audit: null, slug: 'graph-security-2026-11-05' }, row({ reports: ['graph-security'] }))).toBe(true);
  });

  it('flags every shape problem, and passes a well-formed register', () => {
    expect(shapeProblems({ audits: [row()] })).toEqual([]);
    expect(shapeProblems({})).toEqual(['the register has no "audits" list']);
    const bad = shapeProblems({ audits: [row({ owner: '' }), row({ cadenceDays: 0, id: 'b' }), row({ firstDueBy: '2026-02-30', id: 'c' }), row({ id: 'c' }), row({ id: '', scope: '' })] }).join('\n');
    for (const want of [/has no owner/, /cadenceDays/, /real calendar firstDueBy/, /repeats an id/, /has no id/, /has no scope/]) expect(bad).toMatch(want);
  });

  it('refuses unknown keys, an empty dueReason, a malformed reports list and a reasonless retirement', () => {
    expect(shapeProblems({ audits: [row({ firstDueByy: '2026-12-01' })] })[0]).toMatch(/unknown key "firstDueByy"/);
    expect(shapeProblems({ audits: [row()], extra: 1 })[0]).toMatch(/unknown top-level key/);
    expect(shapeProblems({ audits: [row({ dueReason: ' ' })] })[0]).toMatch(/empty dueReason/);
    expect(shapeProblems({ audits: [row({ reports: 'x' })] })[0]).toMatch(/reports/);
    expect(shapeProblems({ audits: [], retired: [{ id: 'sec' }] })[0]).toMatch(/needs an id and a reason/);
  });

  it('a row cannot be snoozed, lengthened or removed against main without a new reason', () => {
    const main = { audits: [row({ dueReason: 'first' })] };
    expect(snoozeProblems({ audits: [row({ dueReason: 'first' })] }, main)).toEqual([]);
    expect(snoozeProblems({ audits: [row({ firstDueBy: '2027-12-01', dueReason: 'first' })] }, main)[0]).toMatch(/moved its firstDueBy later/);
    expect(snoozeProblems({ audits: [row({ cadenceDays: 365, dueReason: 'first' })] }, main)[0]).toMatch(/lengthened its cadenceDays/);
    expect(snoozeProblems({ audits: [row({ firstDueBy: '2027-12-01', dueReason: 'owner on leave until January' })] }, main)).toEqual([]);
    // moving earlier or shortening needs no reason
    expect(snoozeProblems({ audits: [row({ firstDueBy: '2026-11-01', cadenceDays: 7, dueReason: 'first' })] }, main)).toEqual([]);
    expect(snoozeProblems({ audits: [] }, main)[0]).toMatch(/removed without a "retired" entry/);
    expect(snoozeProblems({ audits: [], retired: [{ id: 'sec', reason: 'the surface was deleted' }] }, main)).toEqual([]);
    // no main copy: nothing to compare against
    expect(snoozeProblems({ audits: [] }, null)).toEqual([]);
  });

  it('sorts a row into each of the four states, on both sides of each boundary', () => {
    const r = row({ cadenceDays: 30, firstDueBy: '2026-12-01' });
    expect(rowState(r, [], '2026-12-01').state).toBe('not-yet-due');
    expect(rowState(r, [], '2026-12-02').state).toBe('never-started');
    // converged report: inside and just past cadence + 14 days of grace (44 days)
    const rep = [{ audit: 'sec', slug: 'sec', converged: '2026-10-01' }];
    expect(rowState(r, rep, '2026-11-14').state).toBe('ok');
    expect(rowState(r, rep, '2026-11-15').state).toBe('overdue');
  });

  it('counts only stamped reports as a run, lists unstamped matches, and takes the newest stamped one', () => {
    const out = rowState(row(), [{ audit: null, slug: 'sec-2026-11-05', converged: null }], '2026-12-02');
    expect(out).toMatchObject({ state: 'never-started', unstampedReports: ['sec-2026-11-05'] });
    const reps = [{ audit: 'sec', slug: 'sec-2026-01-01', converged: '2026-01-01' }, { audit: 'sec', slug: 'sec-2026-11-20', converged: '2026-11-20' }];
    expect(rowState(row(), reps, '2026-12-01')).toMatchObject({ state: 'ok', lastConverged: '2026-11-20' });
  });
});

describe('lint-required-audits: the command', () => {
  it('a lapsed audit is reported by name but does not fail the commit check', () => {
    const res = run(fixture({ audits: [row({ firstDueBy: '2026-11-01' })] }), '--today=2026-11-27');
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/never-started — sec \(owner echo-x/);
  });

  it('--fail-on-lapsed exits 1 on a lapse and 0 when all are fine', () => {
    expect(run(fixture({ audits: [row({ firstDueBy: '2026-11-01' })] }), '--today=2026-11-27', '--fail-on-lapsed').status).toBe(1);
    const fine = fixture({ audits: [row({ firstDueBy: '2026-11-01' })] }, { 'sec-2026-11-20.md': stamped('sec', '2026-11-20', '\r\n') });
    expect(run(fine, '--today=2026-11-27', '--fail-on-lapsed').status).toBe(0);
  });

  it('a malformed, missing or unreadable register fails, and so does a bad --today', () => {
    expect(run(fixture({ audits: [row({ owner: '' })] }), '--today=2026-11-27').status).toBe(1);
    expect(run(fixture(undefined), '--today=2026-11-27').status).toBe(1);
    expect(run(fixture('{ not json'), '--today=2026-11-27').status).toBe(1);
    expect(run(fixture({ audits: [row()] }), '--today=27-11-2026').status).toBe(1);
  });

  it('a snooze against main fails the commit check (main copy passed in)', () => {
    const main = path.join(fixture({ audits: [] }), 'main-register.json');
    fs.writeFileSync(main, JSON.stringify({ audits: [row()] }));
    const snoozed = fixture({ audits: [row({ firstDueBy: '2027-06-01' })] });
    const res = spawnSync('node', [SCRIPT, `--root=${snoozed}`, `--main-register=${main}`, '--today=2026-11-27'], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/moved its firstDueBy later without a new dueReason/);
  });

  it('through git, a CI checkout (remote "origin") compares against main and catches a reasonless snooze', () => {
    // upstream repo with the register on main, cloned the way CI checks out (remote named origin)
    const up = fixture({ audits: [row()] });
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
    const g = (cwd: string, ...a: string[]) => { const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
    g(up, 'init', '-q', '-b', 'main'); g(up, 'add', '-A'); g(up, 'commit', '-q', '-m', 'register');
    const ci = fs.mkdtempSync(path.join(os.tmpdir(), 'required-audits-ci-'));
    dirs.push(ci);
    g(ci, 'clone', '-q', up, '.');
    g(ci, 'checkout', '-q', '-b', 'pr');
    const reg = path.join(ci, 'docs/audits/required-audits.json');
    const lint = (...a: string[]) => spawnSync('node', [SCRIPT, `--root=${ci}`, '--today=2026-11-27', ...a], { encoding: 'utf8' });
    fs.writeFileSync(reg, JSON.stringify({ audits: [row({ firstDueBy: '2029-12-01' })] }));
    const snoozed = lint();
    expect(snoozed.status).toBe(1);
    expect(snoozed.stderr).toMatch(/moved its firstDueBy later without a new dueReason/);
    fs.writeFileSync(reg, JSON.stringify({ audits: [row({ firstDueBy: '2029-12-01', dueReason: 'surface rebuilt; first audit after the rebuild' })] }));
    expect(lint().status).toBe(0);
  });

  it('a whitespace-only change to the reason is not a new reason, and a new reports alias needs one', () => {
    const main = { audits: [row({ dueReason: 'owner on leave' })] };
    expect(snoozeProblems({ audits: [row({ firstDueBy: '2027-01-01', dueReason: ' owner  on leave ' })] }, main)[0]).toMatch(/without a new dueReason/);
    expect(snoozeProblems({ audits: [row({ reports: ['unrelated-audit'], dueReason: 'owner on leave' })] }, main)[0]).toMatch(/added a reports alias/);
    expect(snoozeProblems({ audits: [row({ reports: ['renamed-audit'], dueReason: 'the audit was renamed to renamed-audit' })] }, main)).toEqual([]);
  });

  it('--json reports rows on success, and problems with no rows on a malformed register', () => {
    const ok = JSON.parse(run(fixture({ audits: [row({ firstDueBy: '2026-11-01' })] }, { 'sec.md': '# old report\n' }), '--today=2026-11-27', '--json').stdout);
    expect(ok.rows[0]).toMatchObject({ id: 'sec', state: 'never-started', lastConverged: null, unstampedReports: ['sec'] });
    const bad = run(fixture({ audits: [row({ owner: '' })] }), '--today=2026-11-27', '--json');
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ rows: [] });
    expect(JSON.parse(bad.stdout).problems.length).toBeGreaterThan(0);
  });

  it('runs through a symlinked path containing a space (the daily reader unpacks under /var on macOS)', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'req audits real '));
    dirs.push(real);
    fs.mkdirSync(path.join(real, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(real, 'scripts/lint-required-audits.mjs'));
    const link = `${real} link`;
    fs.symlinkSync(real, link);
    dirs.push(link);
    const root = fixture({ audits: [row({ owner: '' })] });
    const res = spawnSync('node', [path.join(link, 'scripts/lint-required-audits.mjs'), `--root=${root}`, '--main-register=none'], { encoding: 'utf8' });
    expect(res.status).toBe(1);
  });

  it('the real register is well formed (the commit-time check on this repository)', () => {
    const res = spawnSync('node', [SCRIPT, '--json', '--main-register=none'], { encoding: 'utf8' });
    expect(JSON.parse(res.stdout).problems).toEqual([]);
    expect(res.status).toBe(0);
  });
});
