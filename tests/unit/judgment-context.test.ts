/**
 * The commit record's judgment block (scripts/lib/judgment-context.mjs;
 * docs/specs/judgment-call-rating.md → "Change 1: the record keeps the call's context").
 */
import { describe, it, expect } from 'vitest';
import {
  boundTierReasoning, secondPassStatus, headingKey, templateHeadings, artifactHeadings,
  specReportPath, buildJudgmentBlock, buildJudgmentBlockSafe, headCommitOf,
  TIER_REASONING_MAX, JUDGMENT_VERSION, SIDE_EFFECTS_TEMPLATE,
} from '../../scripts/lib/judgment-context.mjs';

const TEMPLATE = [
  '# Side-Effects Review — [change title]', '',
  '## Summary of the change', 'x', '',
  '## Decision-point inventory', 'x', '',
  '## 1. Over-block', 'q', '', '## 2. Under-block', 'q', '',
  '## 4b. Judgment-point check (Judgment Within Floors standard)', 'q', '',
  '## 6b. Operator-surface quality (Operator-Surface Quality standard)', 'q', '',
  '## 6c. Delight the user (Delight the User standard)', 'q', '',
  '## 8. Rollback cost', 'q', '',
  '## Conclusion', 'x', '',
  '## Second-pass review (if required)', 'x', '',
  '## Evidence pointers', 'x', '',
].join('\n');

/** A fake io over a map of files: index blobs, HEAD blobs and working files. */
function fakeIo(opts: { files?: Record<string, string>; index?: Record<string, string>; head?: Record<string, string>; staged?: string[]; headCommit?: string | Error } = {}) {
  const files = { [SIDE_EFFECTS_TEMPLATE]: TEMPLATE, ...(opts.files ?? {}) };
  return {
    // Content-based, so two different buffers of the same size never hash alike.
    hashObject: (buf: Buffer | string, p: string) => `h(${p}:${String(buf)})`,
    stagedOid: (p: string) => opts.index?.[p] ?? null,
    headOid: (p: string) => opts.head?.[p] ?? null,
    isStaged: (p: string) => (opts.staged ?? []).includes(p),
    headCommit: () => { if (opts.headCommit instanceof Error) throw opts.headCommit; return opts.headCommit ?? 'a'.repeat(40); },
    readFile: (p: string) => (p in files ? Buffer.from(files[p]) : null),
  };
}

describe('tier reasoning', () => {
  it('records "missing" when the trace has none', () => {
    expect(boundTierReasoning(undefined)).toEqual({ tierReasoning: 'missing' });
    expect(boundTierReasoning('  ')).toEqual({ tierReasoning: 'missing' });
  });
  it('stores a short text as is', () => {
    expect(boundTierReasoning('small fix')).toEqual({ tierReasoning: 'small fix' });
  });
  it('bounds a long text and records its original length', () => {
    const r = boundTierReasoning('y'.repeat(TIER_REASONING_MAX + 10));
    expect(r.tierReasoning).toHaveLength(TIER_REASONING_MAX);
    expect(r.tierReasoningTruncated).toBe(TIER_REASONING_MAX + 10);
  });
  it('scans the WHOLE text first: a secret past the bound still redacts it', () => {
    const tok = 'ghp_' + 'A'.repeat(36);
    const r = boundTierReasoning('z'.repeat(TIER_REASONING_MAX + 50) + ' ' + tok);
    expect(typeof r.tierReasoning).toBe('object');
    expect((r.tierReasoning as { redacted: string }).redacted).toMatch(/\w/);
    expect(JSON.stringify(r)).not.toContain(tok);
  });
});

describe('second-pass status', () => {
  it.each([
    [{ secondPass: 'not-required', reviewerConcurred: true }, 'not-required'],
    [{ secondPass: true, reviewerConcurred: true }, 'required-concurred'],
    [{ secondPass: 'true', reviewerConcurred: 'true' }, 'required-concurred'],
    [{ secondPass: 'required', reviewerConcurred: true }, 'required-concurred'],
    [{ secondPass: true, reviewerConcurred: false }, 'required-not-concurred'],
    [{ secondPass: 'true', reviewerConcurred: null }, 'required-not-concurred'],
    [{ secondPass: false }, 'not-done'],
    [{ secondPass: 'false', reviewerConcurred: true }, 'not-done'],
    [{}, 'unknown'],
    [{ secondPass: null }, 'unknown'],
    [{ secondPass: 'did a quick look' }, 'unknown'],
  ])('%j → %s', (trace, want) => {
    expect(secondPassStatus(trace)).toBe(want);
  });
  it('a missing trace is unknown', () => {
    expect(secondPassStatus(null)).toBe('unknown');
  });
});

describe('headings', () => {
  it('normalizes numbers, letters, parenthesized suffixes and case', () => {
    expect(headingKey('## 4b. Judgment-point check (Judgment Within Floors standard)')).toEqual({ num: '4b', title: 'judgment-point check', key: 'judgment-point check' });
    expect(headingKey('OVER-BLOCK').key).toBe('over-block');
  });
  it('reads required and conditional headings from the template itself', () => {
    const t = templateHeadings(TEMPLATE);
    expect(t.required.map((s: { label: string }) => s.label)).toEqual(['1. Over-block', '2. Under-block', '4b. Judgment-point check', '8. Rollback cost']);
    expect(t.conditional.map((s: { label: string }) => s.label)).toEqual(['6b. Operator-surface quality', '6c. Delight the user', 'Second-pass review']);
  });
  it('records present (with size) or missing for required headings, and conditional ones only when present', () => {
    const art = '## Over-block\nabc\n\n## 2. under-block (notes)\n\n## 6c. Delight the user\nhello\n## Conclusion\nunscored';
    expect(artifactHeadings(art, TEMPLATE)).toEqual({
      '1. Over-block': { present: true, chars: 3 },
      '2. Under-block': { present: true, chars: 0 },
      '4b. Judgment-point check': 'missing',
      '8. Rollback cost': 'missing',
      '6c. Delight the user': { present: true, chars: 5 },
    });
  });
  it('a template without 4b does not require it', () => {
    const t = templateHeadings(TEMPLATE.replace(/## 4b\.[^\n]*\n/, ''));
    expect(t.required.map((s: { label: string }) => s.label)).not.toContain('4b. Judgment-point check');
  });
  it('ignores ### subheadings', () => {
    expect(artifactHeadings('### 1. Over-block\nx', TEMPLATE)['1. Over-block']).toBe('missing');
  });
});

describe('spec report path', () => {
  it('reads review-report from the frontmatter only', () => {
    expect(specReportPath('---\ntitle: x\nreview-report: "docs/specs/reports/x-convergence.md"\n---\nbody')).toBe('docs/specs/reports/x-convergence.md');
    expect(specReportPath('no frontmatter\nreview-report: a.md')).toBeNull();
  });
  it('falls back to the path the gate derives from the frontmatter slug', () => {
    expect(specReportPath('---\nslug: my-spec\n---\nbody')).toBe('docs/specs/reports/my-spec-convergence.md');
    expect(specReportPath('---\ntitle: x\n---\nbody')).toBeNull();
  });
});

describe('buildJudgmentBlock', () => {
  const art = '## 1. Over-block\nnone\n## 8. Rollback cost\nrevert';
  const base = {
    trace: { tierReasoning: 'why', sideEffectsPath: 'upgrades/side-effects/s.md', artifactPath: 'upgrades/side-effects/a.md', secondPass: 'not-required' },
    tracePath: '.instar/instar-dev-traces/t.json',
    traceBuffer: Buffer.from('{"t":1}'),
  };

  it('Tier 1 uses sideEffectsPath, records fingerprints, headings and per-file blobs', () => {
    const io = fakeIo({
      files: { 'upgrades/side-effects/s.md': art },
      index: { 'upgrades/side-effects/s.md': 'oid-s', 'src/a.ts': 'oid-a2' },
      head: { 'src/a.ts': 'oid-a1' },
      staged: ['.instar/instar-dev-traces/t.json'],
    });
    const b = buildJudgmentBlock({ ...base, tier: 1, lines: [{ path: 'src/a.ts', added: 3, deleted: 1 }, { path: 'src/new.ts', added: 9, deleted: 0 }], io });
    expect(b.version).toBe(JUDGMENT_VERSION);
    expect(b.tierReasoning).toBe('why');
    expect(b.trace).toEqual({ path: base.tracePath, hash: 'h(.instar/instar-dev-traces/t.json:{"t":1})', staged: true });
    expect(b.traceDiffers).toBe(false);
    expect(b.validatedTrace).toBeUndefined();
    expect(b.artifact).toEqual({ path: 'upgrades/side-effects/s.md', hash: `h(upgrades/side-effects/s.md:${art})`, stagedHash: 'oid-s' });
    expect(b.spec).toBeNull();
    expect(b.template).toBe(`h(${SIDE_EFFECTS_TEMPLATE}:${TEMPLATE})`);
    expect(b.headings['1. Over-block']).toEqual({ present: true, chars: 4 });
    expect(b.headings['2. Under-block']).toBe('missing');
    expect(b.secondPassStatus).toBe('not-required');
    expect(b.perFileLines).toEqual([
      { path: 'src/a.ts', added: 3, deleted: 1, baseBlob: 'oid-a1', stagedBlob: 'oid-a2' },
      { path: 'src/new.ts', added: 9, deleted: 0, baseBlob: null, stagedBlob: null },
    ]);
  });

  it('prefers the buffer the hook checked over a fresh read of the artifact', () => {
    const io = fakeIo({ files: { 'upgrades/side-effects/s.md': 'changed on disk' } });
    const b = buildJudgmentBlock({ ...base, tier: 1, artifactBuffer: Buffer.from(art), io });
    expect(b.artifact.hash).toBe(`h(upgrades/side-effects/s.md:${art})`);
  });

  it('Tier 2+ uses artifactPath and records a validated trace that differs', () => {
    const io = fakeIo({ files: { 'upgrades/side-effects/a.md': art } });
    const b = buildJudgmentBlock({ ...base, tier: 2, validated: { path: '.instar/instar-dev-traces/other.json', buffer: Buffer.from('xx') }, io });
    expect(b.artifact.path).toBe('upgrades/side-effects/a.md');
    expect(b.traceDiffers).toBe(true);
    expect(b.validatedTrace).toEqual({ path: '.instar/instar-dev-traces/other.json', hash: 'h(.instar/instar-dev-traces/other.json:xx)' });
  });

  it('Tier 2+ with the same validated trace records traceDiffers false', () => {
    const b = buildJudgmentBlock({ ...base, tier: 2, validated: { path: base.tracePath, buffer: base.traceBuffer }, io: fakeIo() });
    expect(b.traceDiffers).toBe(false);
    expect(b.validatedTrace).toBeUndefined();
  });

  it('records the spec: staged blob when staged, HEAD blob otherwise, and its convergence report from the index', () => {
    const spec = '---\nreview-report: "docs/specs/reports/x-convergence.md"\n---\nbody';
    const trace = { ...base.trace, specPath: 'docs/specs/x.md' };
    const stagedIo = fakeIo({ files: { 'docs/specs/x.md': spec }, index: { 'docs/specs/x.md': 'oid-spec-i', 'docs/specs/reports/x-convergence.md': 'oid-rep' }, head: { 'docs/specs/x.md': 'oid-spec-h' }, staged: ['docs/specs/x.md'] });
    const s1 = buildJudgmentBlock({ ...base, trace, tier: 2, io: stagedIo }).spec;
    expect(s1).toEqual({ path: 'docs/specs/x.md', hash: `h(docs/specs/x.md:${spec})`, stagedHash: 'oid-spec-i', staged: true, convergenceReport: { path: 'docs/specs/reports/x-convergence.md', stagedHash: 'oid-rep' } });
    const headIo = fakeIo({ files: { 'docs/specs/x.md': spec }, head: { 'docs/specs/x.md': 'oid-spec-h' } });
    const s2 = buildJudgmentBlock({ ...base, trace, tier: 2, io: headIo }).spec;
    expect(s2.stagedHash).toBe('oid-spec-h');
    expect(s2.staged).toBe(false);
    expect(s2.convergenceReport).toBeNull();
    const noneIo = fakeIo({ files: { 'docs/specs/x.md': spec } });
    expect(buildJudgmentBlock({ ...base, trace, tier: 2, io: noneIo }).spec.stagedHash).toBeNull();
  });

  it('records no spec on Tier 1, even when the trace names one', () => {
    const io = fakeIo({ files: { 'docs/specs/x.md': '---\nslug: x\n---\n' } });
    expect(buildJudgmentBlock({ ...base, trace: { ...base.trace, specPath: 'docs/specs/x.md' }, tier: 1, io }).spec).toBeNull();
  });

  it('an artifact path the trace does not name records null, and headings null', () => {
    const b = buildJudgmentBlock({ ...base, trace: { tierReasoning: 'x' }, tier: 1, io: fakeIo() });
    expect(b.artifact).toBeNull();
    expect(b.headings).toBeNull();
    expect(b.secondPassStatus).toBe('unknown');
  });

  it('never throws through the safe builder: a failing read becomes { version, error }', () => {
    const io = { ...fakeIo(), hashObject: () => { throw new Error('git hash-object failed'); } };
    expect(buildJudgmentBlockSafe({ ...base, tier: 1, io })).toEqual({ version: JUDGMENT_VERSION, error: 'git hash-object failed' });
  });

  it('headCommitOf returns null on an unborn branch', () => {
    expect(headCommitOf(fakeIo({ headCommit: new Error('unborn') }))).toBeNull();
    expect(headCommitOf(fakeIo())).toBe('a'.repeat(40));
  });
});
