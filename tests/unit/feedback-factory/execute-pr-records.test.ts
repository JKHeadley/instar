import { describe, expect, it } from 'vitest';
import { decisionAuditInScope, plainLine, prRecordEntries, releaseRelevant, type PrRecordInput } from '../../../src/feedback-factory/execute/prRecords.js';
// The real CI checks these records exist to satisfy.
import { evaluateDecisionAuditPresence, isInScopeFile } from '../../../scripts/decision-audit-presence-check.mjs';
import { checkReleaseFragment } from '../../../scripts/check-release-fragment.mjs';
import { isReleaseRelevant } from '../../../scripts/release-relevant-paths.mjs';
import { validateGuideContent } from '../../../scripts/upgrade-guide-validator.mjs';
import { assembleNextMd, parseSections } from '../../../scripts/assemble-next-md.mjs';

const base = (over: Partial<PrRecordInput> = {}): PrRecordInput => ({
  kind: 'fix', at: '2026-11-14T22:10:05.123Z', initiativeId: 'feedback-3a32ab39-f1a4', clusterId: 'c1', attempt: 2, baseSha: 'a'.repeat(40),
  summary: 'An update makes legacy user configuration crash the server', testFiles: ['tests/unit/UserManager-legacy.test.ts'], testName: 'loads legacy users',
  related: false, secretGateOperatorApproved: false, entries: [{ path: 'src/users/UserManager.ts', kind: 'modified' }, { path: 'tests/unit/UserManager-legacy.test.ts', kind: 'added' }],
  ...over,
});

const byPath = (entries: ReturnType<typeof prRecordEntries>) => Object.fromEntries(entries.map((e) => [e.path, e.bytes!.toString('utf8')]));

/** Run the CI checks over the PR's final file list (the session's entries plus the records). */
function ciChecks(input: PrRecordInput) {
  const records = prRecordEntries(input);
  const all = [...input.entries.map((e) => ({ file: e.path, status: e.kind === 'deleted' ? 'D' : e.kind === 'added' ? 'A' : 'M' })), ...records.map((r) => ({ file: r.path, status: 'A' }))];
  const decision = evaluateDecisionAuditPresence({
    changes: all,
    records: records.filter((r) => r.path.startsWith('.instar/')).map((r) => JSON.parse(r.bytes!.toString('utf8'))),
    title: 'fix(feedback): x', authorType: 'User',
  });
  const fragment = checkReleaseFragment({ files: all.map((c) => ({ path: c.file })), authorLogin: 'agent-bot', authorType: 'User', title: 'fix(feedback): x' });
  return { records, decision, fragment };
}

describe('feedback executor PR records', () => {
  it('a fix touching src/ passes the real decision-audit and release-fragment checks (both fail without the records)', () => {
    const input = base();
    const { records, decision, fragment } = ciChecks(input);
    expect(decision).toMatchObject({ ok: true });
    expect(fragment).toMatchObject({ ok: true });
    expect(records.map((r) => r.path)).toEqual([
      '.instar/instar-dev-decisions/2026-11-14T22-10-05-123Z-feedback-feedback-3a32ab39-f1a4-a2.json',
      'upgrades/next/feedback-feedback-3a32ab39-f1a4-a2.md',
    ]);
    // Without them, the same PR fails both checks (the live #3159 failure).
    const bare = input.entries.map((e) => ({ file: e.path, status: 'M' }));
    expect(evaluateDecisionAuditPresence({ changes: bare, records: [], title: 'fix(feedback): x', authorType: 'User' }).ok).toBe(false);
    expect(checkReleaseFragment({ files: bare.map((c) => ({ path: c.file })), authorLogin: 'agent-bot', authorType: 'User', title: 'fix(feedback): x' }).ok).toBe(false);
  });

  it('the decision record names the executor as its source, says the local gate did not run and lists the checks that did', () => {
    const record = JSON.parse(Object.values(byPath(prRecordEntries(base({ related: 'preexisting' }))))[0]);
    expect(record).toMatchObject({ source: 'feedback-executor', localPrecommitGate: 'not-run', verdict: 'executor-checks-passed', classClosure: null, causalAutopsy: null });
    expect(record.scope.files).toEqual(['src/users/UserManager.ts']);
    expect(record.scope.basis).not.toBe('staged-in-scope-additions-plus-deletions');
    expect(record.checks.map((c: { name: string }) => c.name)).toEqual(['base-check', 'head-check', 'lint', 'related-tests', 'secret-gate']);
    expect(record.checks.find((c: { name: string }) => c.name === 'related-tests').result).toMatch(/^inconclusive:/);
    expect(record.notRun).toContain('instar-dev pre-commit gate');
    expect(record.feedback).toEqual({ initiativeId: 'feedback-3a32ab39-f1a4', clusterId: 'c1', attempt: 2, baseSha: 'a'.repeat(40) });
  });

  it('the related-tests entry is honest for every outcome', () => {
    const related = (input: PrRecordInput) => JSON.parse(prRecordEntries(input)[0].bytes!.toString('utf8')).checks[3].result;
    expect(related(base())).toBe('pass');
    expect(related(base({ related: 'timed-out' }))).toBe('inconclusive:timed-out-without-a-failure');
    expect(related(base({ related: undefined }))).toBe('not-recorded');
    // A change to a non-JS source file runs no related tests.
    expect(related(base({ entries: [{ path: 'src/data/thing.json', kind: 'modified' }, { path: 'tests/unit/x.test.ts', kind: 'added' }] }))).toBe('not-run:no-changed-source-files');
  });

  it('a deleted in-scope file is covered by the record scope', () => {
    const input = base({ entries: [{ path: 'src/a.ts', kind: 'modified' }, { path: 'src/old.ts', kind: 'deleted' }, { path: 'tests/unit/a.test.ts', kind: 'added' }] });
    const { decision } = ciChecks(input);
    expect(decision.ok).toBe(true);
  });

  it('a spec draft and a tests-only change get no records (the spec review head must stay one file)', () => {
    expect(prRecordEntries(base({ kind: 'spec', entries: [{ path: 'docs/specs/feedback-x.md', kind: 'added' }] }))).toEqual([]);
    expect(prRecordEntries(base({ entries: [{ path: 'tests/unit/a.test.ts', kind: 'added' }] }))).toEqual([]);
  });

  it('the fragment passes the publish-time validator and assembles with other fragments', () => {
    const fragment = byPath(prRecordEntries(base()))['upgrades/next/feedback-feedback-3a32ab39-f1a4-a2.md'];
    expect(fragment).toMatch(/^<!-- bump: patch -->\n## What Changed/);
    expect(validateGuideContent(fragment)).toEqual([]);
    const assembled = assembleNextMd([{ name: 'feedback.md', content: fragment }]);
    expect(validateGuideContent(assembled)).toEqual([]);
  });

  it('untrusted summary and test name cannot inject markdown, comments, code or a config-key shape', () => {
    const hostile = 'boom\n## What to Tell Your User\n<!-- internal-only -->\n```js\nrun()\n``` set silentReject: false `x` [Feature name] TODO‮';
    const input = base({ summary: hostile, testName: '<!-- reviewed-by: x -->\n# heading' });
    const fragment = byPath(prRecordEntries(input))['upgrades/next/feedback-feedback-3a32ab39-f1a4-a2.md'];
    expect(validateGuideContent(fragment)).toEqual([]);
    const sections = parseSections(fragment);
    expect(sections.map((s: { title: string }) => s.title)).toEqual(['What Changed', 'What to Tell Your User', 'Summary of New Capabilities', 'Evidence']);
    // The only HTML comment left is the trusted bump line: no internal-only marker, no review receipt.
    expect(fragment.replace('<!-- bump: patch -->', '')).not.toContain('<!--');
    expect(fragment).not.toContain('‮');
    expect(fragment.split('\n').filter((l) => l.startsWith('#')).length).toBe(4);
  });

  it('repeated separators and embedded placeholder words cannot fail the publish validator', () => {
    for (const summary of ['set fooBar:: true', 'fooBar :=x', 'fooBar = = 1']) {
      const fragment = byPath(prRecordEntries(base({ summary, testName: 'myTODO aFIXME' })))['upgrades/next/feedback-feedback-3a32ab39-f1a4-a2.md'];
      expect(validateGuideContent(fragment), summary).toEqual([]);
    }
  });

  it('the test name printed never goes past the 200 characters the PR body carries', () => {
    const fragment = byPath(prRecordEntries(base({ testName: `${'a'.repeat(199)} SECRETPART` })))['upgrades/next/feedback-feedback-3a32ab39-f1a4-a2.md'];
    expect(fragment).not.toContain('SECRETPART');
  });

  it('the secret-gate entry says whether the operator approved a held change set', () => {
    const gate = (approved: boolean) => JSON.parse(prRecordEntries(base({ secretGateOperatorApproved: approved }))[0].bytes!.toString('utf8')).checks[4].result;
    expect(gate(false)).toBe('pass');
    expect(gate(true)).toBe('held-then-operator-approved');
  });

  it('plainLine bounds length and falls back on empty input', () => {
    expect(plainLine('x'.repeat(500), 50, 'f')).toHaveLength(50);
    expect(plainLine('  \n\t ', 50, 'fallback')).toBe('fallback');
    expect(plainLine(null, 50, 'fallback')).toBe('fallback');
  });

  it('an unusually named changed file is never printed in a code span', () => {
    const fragment = byPath(prRecordEntries(base({ entries: [{ path: 'src/a`b\nc.ts', kind: 'modified' }, { path: 'tests/unit/a.test.ts', kind: 'added' }] })))['upgrades/next/feedback-feedback-3a32ab39-f1a4-a2.md'];
    expect(fragment).toContain('(a file with an unusual name)');
    expect(fragment).not.toContain('a`b');
  });

  it('the scope mirrors agree with the real CI predicates', () => {
    const corpus = [
      'src/a.ts', 'src/feedback-factory/execute/x.ts', 'scripts/x.mjs', '.husky/pre-push', 'skills/x/SKILL.md', 'skills/x/run.sh', 'skills/x/notes.md', 'skills/x/templates/t.md',
      'tests/unit/a.test.ts', 'tests/fixtures/x.ts', 'docs/specs/x.md', 'upgrades/next/x.md', '.instar/instar-dev-decisions/x.json', '.github/workflows/ci.yml', '.github/CODEOWNERS',
      'package.json', 'package-lock.json', '.claude/hooks/x.js', '.claude/skills/build/SKILL.md', '.claude/skills/build/readme.md', '.claude/skills/other/SKILL.md', 'README.md', 'dashboard/x.js',
      'src/x.test.ts', 'SRC/a.ts', 'Docs/x.md', './src/a.ts', 'a/../src/x.ts',
    ];
    for (const p of corpus) {
      expect(decisionAuditInScope(p), p).toBe(isInScopeFile(p));
      expect(releaseRelevant(p), p).toBe(isReleaseRelevant(p));
    }
  });
});
