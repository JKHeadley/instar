/**
 * Tier-1 tests for the local-verify record: validation, keys and the
 * commit-status description (spec local-verify-merge-authority.md §2 steps 6–7, Keys).
 */

import { describe, it, expect } from 'vitest';
import {
  validateRecord, recordKey, executionKey, statusDescription, stateLabel, type LocalVerifyRecord,
} from '../../../src/localVerify/record.js';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const T = 'c'.repeat(40);

function rec(over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
  return {
    repo: 'JKHeadley/instar', pr: 2190, headSha: H, baseSha: B, baseRefName: 'main', mergeTree: T,
    lanes: [
      { name: 'unit', gating: true, files: 1800, tests: 48211, passed: 48000, failed: 0, skipped: 200, todo: 11, seconds: 540 },
      { name: 'integration', gating: true, files: 400, tests: 6120, passed: 6100, failed: 0, skipped: 20, todo: 0, seconds: 1500 },
      { name: 'e2e', gating: true, files: 210, tests: 1980, passed: 1970, failed: 0, skipped: 10, todo: 0, seconds: 900 },
    ],
    nodeVersion: 'v24.1.0', machineId: 'm_studio', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:47:12.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.3.1204', policyHash: 'f'.repeat(64), ...over,
  };
}

describe('validateRecord', () => {
  it('accepts a well-formed record', () => {
    expect(validateRecord(rec())).toMatchObject({ ok: true });
  });
  it.each([
    ['headSha', { headSha: 'A'.repeat(40) }],
    ['headSha', { headSha: 'a'.repeat(39) }],
    ['baseSha', { baseSha: 'xyz' }],
    ['mergeTree', { mergeTree: '' }],
    ['pr', { pr: 0 }],
    ['pr', { pr: -3 }],
    ['pr', { pr: 1.5 }],
    ['pr', { pr: '12' as never }],
    ['repo', { repo: 'not a repo' }],
    ['baseRefName', { baseRefName: 'bad..ref' }],
    ['baseRefName', { baseRefName: 'has space' }],
    ['outcome', { outcome: 'passed' as never }],
    ['harnessChanging', { harnessChanging: 'no' as never }],
    ['startedAt', { startedAt: 'yesterday' }],
    ['finishedAt<startedAt', { finishedAt: '2026-10-21T09:00:00.000Z' }],
    ['lanes', { lanes: [{ name: 'unit' } as never] }],
    ['policyHash', { policyHash: '' }],
  ])('rejects bad %s', (field, over) => {
    const v = validateRecord(rec(over as Partial<LocalVerifyRecord>));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors).toContain(field);
  });
  it('an error that stopped before the merge tree may carry an empty mergeTree; nothing else may', () => {
    expect(validateRecord(rec({ outcome: 'error', errorStep: 'fetch', mergeTree: '' })).ok).toBe(true);
    expect(validateRecord(rec({ outcome: 'failure', mergeTree: '' })).ok).toBe(false);
  });
  it('an independent review is optional; when present it must name a trace path and concur', () => {
    expect(validateRecord(rec({ protectedPath: true, independentReview: { trace: '.instar/instar-dev-traces/t.json', concurred: true } })).ok).toBe(true);
    for (const bad of [{ trace: 'docs/t.json', concurred: true }, { trace: '.instar/instar-dev-traces/t.json', concurred: false }, null, 'x']) {
      const v = validateRecord({ ...rec(), independentReview: bad } as unknown);
      expect(v.ok).toBe(false);
      expect(!v.ok && v.errors).toContain('independentReview');
    }
  });

  it('preserves bounded observe evidence but rejects an early red as green authority', () => {
    const evidence = {
      mode: 'observe' as const, outcome: 'red' as const, reason: 'stable-red-observed', elapsedMs: 1200,
      changedFiles: 2, selectedFiles: ['tests/unit/example.test.ts'], selectedCases: 3,
      headSha: H, baseSha: B, repeatedFailedFile: 'tests/unit/example.test.ts',
    };
    expect(validateRecord(rec({ preflight: evidence })).ok).toBe(true); // full lanes decide green
    const enforced = { ...evidence, mode: 'enforce' as const, reason: 'preflight-red' };
    expect(validateRecord(rec({ preflight: enforced })).ok).toBe(false);
    expect(validateRecord(rec({ outcome: 'failure', lanes: [], preflight: enforced })).ok).toBe(true);
    const malformed = validateRecord({ ...rec({ outcome: 'failure', preflight: enforced }), lanes: null });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.errors).toContain('lanes');
  });

  it('refuses malformed or mismatched preflight evidence before peer import', () => {
    const valid = {
      mode: 'enforce' as const, outcome: 'red' as const, reason: 'preflight-red', elapsedMs: 1200,
      changedFiles: 2, selectedFiles: ['tests/unit/example.test.ts'], selectedCases: 3,
      headSha: H, baseSha: B, repeatedFailedFile: 'tests/unit/example.test.ts',
    };
    const base = rec({ outcome: 'failure', lanes: [] });
    for (const bad of [
      { ...valid, baseSha: T },
      { ...valid, repeatedFailedFile: '../outside.test.ts' },
      { ...valid, selectedFiles: ['/tmp/fake.test.ts'] },
      { ...valid, selectedFiles: Array(6).fill('tests/unit/example.test.ts') },
      { ...valid, elapsedMs: 90_001 },
      { ...valid, selectedCases: 0 },
    ]) {
      const result = validateRecord({ ...base, preflight: bad });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.errors).toContain('preflight');
    }
  });

  it('accepts only a complete, bounded, sorted PR failed-file set', () => {
    const files = ['tests/integration/b.test.ts', 'tests/unit/a.test.ts'];
    expect(validateRecord(rec({ outcome: 'failure', failedFiles: files })).ok).toBe(true);
    for (const bad of [
      [], [...files].reverse(), [files[0], files[0]],
      ['tests/unit/../fixtures/a.test.ts'], ['tests/unit/./a.test.ts'], ['src/outside.test.ts'],
      ['tests/unit/a.test.ts', 'tests/unit/b.test.ts', 'tests/unit/c.test.ts', 'tests/unit/d.test.ts'],
    ]) {
      const v = validateRecord(rec({ outcome: 'failure', failedFiles: bad }));
      expect(!v.ok && v.errors).toContain('failedFiles');
    }
    expect(validateRecord(rec({ failedFiles: [files[0]] })).ok).toBe(false);
    expect(validateRecord(rec({ kind: 'main', pr: 0, headSha: B, outcome: 'failure', failedFiles: [files[0]] })).ok).toBe(false);
  });

  it('a main record may carry the peer attempt it answers (a peer ran it for the coordinator); a malformed one is still refused', () => {
    const attempt = { id: 'a'.repeat(32), coordinatorMachineId: 'coord', leaseEpoch: 7 };
    expect(validateRecord(rec({ kind: 'main', pr: 0, headSha: B, attempt })).ok).toBe(true);
    const bad = validateRecord(rec({ kind: 'main', pr: 0, headSha: B, attempt: { ...attempt, id: 'nope' } }));
    expect(!bad.ok && bad.errors).toContain('attempt');
  });

  it('rejects non-objects', () => {
    expect(validateRecord(null)).toEqual({ ok: false, errors: ['not-an-object'] });
  });
});

describe('keys', () => {
  it('record key is (repo, pr, headSha, baseRefName)', () => {
    const k = recordKey('JKHeadley/instar', 5, H, 'main');
    expect(k).not.toBe(recordKey('JKHeadley/instar', 5, H, 'release'));
    expect(k).not.toBe(recordKey('JKHeadley/instar', 6, H, 'main'));
    expect(k).not.toBe(recordKey('JKHeadley/instar', 5, B, 'main'));
    expect(k).toBe(recordKey('JKHeadley/instar', 5, H, 'main'));
  });
  it('record key refuses invalid parts', () => {
    expect(() => recordKey('JKHeadley/instar', 0, H, 'main')).toThrow();
    expect(() => recordKey('JKHeadley/instar', 5, 'abc', 'main')).toThrow();
    expect(() => recordKey('nope', 5, H, 'main')).toThrow();
  });
  it('execution key is (head, base)', () => {
    expect(executionKey(H, B)).toBe(`${H}:${B}`);
    expect(() => executionKey(H, 'x')).toThrow();
  });
});

describe('statusDescription', () => {
  it('puts the state label first, then wall time and lane counts', () => {
    expect(statusDescription(rec())).toBe('verified · 47m12s · unit 48211t/0f integration 6120t/0f e2e 1980t/0f');
  });
  it('labels each operator-routing flag', () => {
    expect(stateLabel(rec({ harnessChanging: true }))).toBe('harness-changing');
    expect(stateLabel(rec({ skipsAdded: true, testsRemoved: true }))).toBe('skips-added+tests-removed');
    expect(stateLabel(rec({ protectedPath: true }))).toBe('protected-path');
    expect(statusDescription(rec({ harnessChanging: true }))).toMatch(/^harness-changing · /);
  });
  it('failure and error labels win over flags; error names the step', () => {
    expect(stateLabel(rec({ outcome: 'failure', harnessChanging: true }))).toBe('failed');
    expect(stateLabel(rec({ outcome: 'error', errorStep: 'npm-ci' }))).toBe('error:npm-ci');
    expect(stateLabel(rec({ outcome: 'error' }))).toBe('error');
  });
  it('is cut to 140 characters with the label kept', () => {
    const lanes = Array.from({ length: 12 }, (_, i) => ({ name: `lane${i}` as never, gating: true, files: 99999, tests: 999999, passed: 1, failed: 99999, skipped: 0, todo: 0, seconds: 1 }));
    const d = statusDescription(rec({ outcome: 'error', errorStep: 'integration-lane-deadline', lanes }));
    expect(d.length).toBe(140);
    expect(d.startsWith('error:integration-lane-deadline · ')).toBe(true);
    expect(d.endsWith('…')).toBe(true);
  });
  it('hours are shown for long runs', () => {
    expect(statusDescription(rec({ finishedAt: '2026-10-21T12:05:00.000Z' }))).toMatch(/^verified · 2h5m · /);
  });
});

// ── flakyRetried name fields (spec local-verify-import-related-rerun.md, Recording) ──

describe('validateRecord — flakyRetried name fields', () => {
  const HASH = 'ab'.repeat(32);
  const entry = (over: Record<string, unknown> = {}) => ({ file: 'tests/unit/a.test.ts', lane: 'unit', firstMessage: 't: boom', ...over });
  const withEntry = (e: Record<string, unknown>) => validateRecord(rec({ flakyRetried: [e as never] }));
  const ev = (test: string) => ({ test, mainAt: '2026-11-16T10:00:00.000Z', mainLine: 'Error: x', prLine: 'Error: x', mainRunLog: 'a'.repeat(32) + '.log' });
  const clear = (over: Record<string, unknown> = {}) => entry({
    importRelated: true, failedTests: ['s one', 's two'], failedTestsTotal: 2, soloPassedByName: ['s one', 's two'], testSetHash: HASH,
    soloPasses: 3, soloSeconds: [1, 2, 3], evidence: [ev('s one'), ev('s two')], ...over,
  });

  it('shared fields: allowed on any entry, each with its refusals', () => {
    expect(withEntry(entry({ failedTests: ['a', 'b'], failedTestsTotal: 3, soloPassedByName: ['b'], testSetHash: HASH })).ok).toBe(true);
    expect(validateRecord(rec({ kind: 'main', pr: 0, baseSha: H, flakyRetried: [entry({ failedTests: ['a'], failedTestsTotal: 1, soloPassedByName: [], testSetHash: HASH }) as never] })).ok).toBe(true);
    expect(withEntry(entry({ failedTests: [], failedTestsTotal: 2 })).ok).toBe(true); // every name was left out for length: disclosed by the total
    const bad: Array<Record<string, unknown>> = [
      { failedTests: Array.from({ length: 21 }, (_, i) => `t${i}`), failedTestsTotal: 21 },
      { failedTests: ['x'.repeat(301)], failedTestsTotal: 1 },
      { failedTests: [''], failedTestsTotal: 1 },
      { failedTests: 'a' },
      { failedTests: ['a', 'b'], failedTestsTotal: 1 }, // the total may not be below the list
      { failedTests: ['a'], failedTestsTotal: 1.5 },
      { failedTests: ['a'], failedTestsTotal: 1, soloPassedByName: ['b'] }, // not a subset
      { soloPassedByName: ['a'] }, // nothing to be a subset of
      { testSetHash: 'nope' },
      { testSetHash: HASH.toUpperCase() },
    ];
    for (const b of bad) {
      const v = withEntry(entry(b));
      expect(v.ok, JSON.stringify(b).slice(0, 80)).toBe(false);
      if (!v.ok) expect(v.errors).toContain('flakyRetried');
    }
  });

  it('clearance fields: only with importRelated, and then complete, each with its refusals', () => {
    expect(withEntry(clear()).ok).toBe(true);
    expect(withEntry(clear({ evidence: [{ ...ev('s one'), mainLineCut: true, prLineCut: true }, ev('s two')] })).ok).toBe(true);
    const { importRelated: _i, ...noFlag } = clear(); void _i;
    const bad: Array<Record<string, unknown>> = [
      noFlag, // clearance fields without importRelated
      entry({ soloPasses: 3 }),
      entry({ soloSeconds: [1, 2, 3] }),
      entry({ evidence: [] }),
      clear({ importRelated: false }),
      clear({ soloPasses: 2 }),
      clear({ soloSeconds: [1, 2] }),
      clear({ soloSeconds: [1, 2, -1] }),
      clear({ failedTestsTotal: 3 }), // a name was left out: not the whole truth
      clear({ failedTests: [], failedTestsTotal: 0, soloPassedByName: [], evidence: [] }), // no vacuous clear
      clear({ soloPassedByName: ['s one'] }),
      clear({ evidence: [ev('s one')] }),
      clear({ evidence: [ev('s one'), ev('other')] }),
      clear({ evidence: [ev('s one'), { ...ev('s two'), mainAt: 'yesterday' }] }),
      clear({ evidence: [ev('s one'), { ...ev('s two'), prLine: 'x'.repeat(401) }] }),
      clear({ evidence: [ev('s one'), { ...ev('s two'), mainLineCut: false }] }),
      clear({ testSetHash: undefined }),
      entry({ importRelated: true }), // the flag alone
    ];
    for (const b of bad) {
      const v = withEntry(b);
      expect(v.ok, JSON.stringify(b).slice(0, 120)).toBe(false);
      if (!v.ok) expect(v.errors).toContain('flakyRetried');
    }
  });
});
