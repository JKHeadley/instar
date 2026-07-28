import { describe, it, expect } from 'vitest';
import {
  extractFailureLines,
  runDevCiFailures,
  type CiAnnotation,
  type CiFailuresDeps,
} from '../../src/commands/devCiFailures.js';

describe('extractFailureLines', () => {
  it('keeps a real test failure with its path:line + assertion', () => {
    const ann: CiAnnotation[] = [
      { path: 'tests/unit/foo.test.ts', start_line: 111, annotation_level: 'failure', message: 'AssertionError: expected X to be Y' },
    ];
    expect(extractFailureLines(ann)).toEqual(['tests/unit/foo.test.ts:111\nAssertionError: expected X to be Y']);
  });

  it('drops non-failure levels (warnings/notices)', () => {
    const ann: CiAnnotation[] = [
      { path: '.github', start_line: 2, annotation_level: 'warning', message: 'Node.js 20 actions are deprecated.' },
      { path: 'tests/unit/x.test.ts', start_line: 9, annotation_level: 'notice', message: 'a notice' },
    ];
    expect(extractFailureLines(ann)).toEqual([]);
  });

  it('drops workflow-runner noise (.github path + "Process completed with exit code N")', () => {
    const ann: CiAnnotation[] = [
      { path: '.github', start_line: 13734, annotation_level: 'failure', message: 'Process completed with exit code 1.' },
      { path: '.github/workflows/ci.yml', start_line: 1, annotation_level: 'failure', message: 'some workflow failure' },
      { path: 'src/foo.ts', annotation_level: 'failure', message: 'Process completed with exit code 1' },
    ];
    expect(extractFailureLines(ann)).toEqual([]);
  });

  it('truncates a long multi-line assertion message', () => {
    const msg = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n');
    const out = extractFailureLines([{ path: 'a.test.ts', start_line: 1, annotation_level: 'failure', message: msg }]);
    expect(out[0].split('\n').length).toBe(1 + 6); // loc line + first 6 message lines
  });

  it('handles a missing path/line and empty message', () => {
    const ann: CiAnnotation[] = [
      { annotation_level: 'failure', message: 'no path' },
      { path: 'b.test.ts', start_line: 3, annotation_level: 'failure', message: '   ' },
    ];
    expect(extractFailureLines(ann)).toEqual(['(no path)\nno path']);
  });
});

/** Build injectable gh deps from canned responses keyed by a substring of the args. */
function mockDeps(responses: Array<{ match: string; value: unknown; throws?: string }>): CiFailuresDeps {
  return {
    ghJson: async (args: string[]) => {
      const joined = args.join(' ');
      const hit = responses.find((r) => joined.includes(r.match));
      if (!hit) throw new Error(`unexpected gh call: ${joined}`);
      if (hit.throws) throw new Error(hit.throws);
      return hit.value;
    },
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { output: { write: (t: string) => out.push(t), error: (t: string) => err.push(t) }, out, err };
}

describe('runDevCiFailures', () => {
  it('prints the failing test for a red PR and exits 0 (diagnostic, not a gate)', async () => {
    const deps = mockDeps([
      { match: 'pr view 42', value: { headRefOid: 'abc123def456' } },
      { match: 'commits/abc123def456/check-runs', value: { check_runs: [
        { id: 1, name: 'Unit shard 2/4', conclusion: 'failure' },
        { id: 2, name: 'Type Check', conclusion: 'success' },
      ] } },
      { match: 'check-runs/1/annotations', value: [
        { path: 'tests/unit/foo.test.ts', start_line: 111, annotation_level: 'failure', message: 'AssertionError: nope' },
      ] },
    ]);
    const cap = capture();
    const code = await runDevCiFailures({ pr: '42', repo: 'o/r', deps, output: cap.output });
    expect(code).toBe(0);
    const text = cap.out.join('');
    expect(text).toContain('1 failed check');
    expect(text).toContain('tests/unit/foo.test.ts:111');
    expect(text).toContain('AssertionError: nope');
  });

  it('dedupes the identical failure reported by node-20 and node-22 shard checks', async () => {
    const sameAnnotation = [
      { path: 'tests/unit/dup.test.ts', start_line: 5, annotation_level: 'failure', message: 'boom' },
    ];
    const deps = mockDeps([
      { match: 'pr view 7', value: { headRefOid: 'deadbeef00' } },
      { match: 'commits/deadbeef00/check-runs', value: { check_runs: [
        { id: 10, name: 'Unit (node 20, shard 2/4)', conclusion: 'failure' },
        { id: 11, name: 'Unit (node 22, shard 2/4)', conclusion: 'failure' },
      ] } },
      { match: 'check-runs/10/annotations', value: sameAnnotation },
      { match: 'check-runs/11/annotations', value: sameAnnotation },
    ]);
    const cap = capture();
    await runDevCiFailures({ pr: '7', repo: 'o/r', deps, output: cap.output });
    const occurrences = cap.out.join('').split('tests/unit/dup.test.ts:5').length - 1;
    expect(occurrences).toBe(1); // printed once despite two checks
  });

  it('reports "No failed checks" + exit 0 when CI is green', async () => {
    const deps = mockDeps([
      { match: 'pr view 5', value: { headRefOid: 'green00' } },
      { match: 'commits/green00/check-runs', value: { check_runs: [{ id: 1, name: 'x', conclusion: 'success' }] } },
    ]);
    const cap = capture();
    const code = await runDevCiFailures({ pr: '5', repo: 'o/r', deps, output: cap.output });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('No failed checks');
  });

  it('exits 1 with an error message when the PR cannot be resolved', async () => {
    const deps = mockDeps([{ match: 'pr view 999', throws: 'no such PR', value: null }]);
    const cap = capture();
    const code = await runDevCiFailures({ pr: '999', repo: 'o/r', deps, output: cap.output });
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('Could not resolve PR #999');
  });

  it('notes when failed checks have no test-level annotations (build/lint step)', async () => {
    const deps = mockDeps([
      { match: 'pr view 8', value: { headRefOid: 'buildfail0' } },
      { match: 'commits/buildfail0/check-runs', value: { check_runs: [{ id: 3, name: 'Build', conclusion: 'failure' }] } },
      { match: 'check-runs/3/annotations', value: [
        { path: '.github', start_line: 1, annotation_level: 'failure', message: 'Process completed with exit code 1.' },
      ] },
    ]);
    const cap = capture();
    const code = await runDevCiFailures({ pr: '8', repo: 'o/r', deps, output: cap.output });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('no test-level annotations');
  });
});
