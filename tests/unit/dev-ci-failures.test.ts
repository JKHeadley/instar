/**
 * `instar dev:ci-failures` — a red PR's failure annotations.
 *
 * The load-bearing distinction: a check whose annotations could NOT BE READ is
 * not a check with NO annotations. The zero-case message diagnoses the failure's
 * NATURE ("likely a build/lint/type step"), so collapsing the two makes the tool
 * assert something about data it never received — and this command exists
 * precisely for the case where other tooling comes back empty.
 *
 * The `gh` boundary is injected — no network.
 */

import { describe, expect, it } from 'vitest';
import {
  extractFailureLines,
  runDevCiFailures,
  type CiAnnotation,
  type CiFailuresOutput,
} from '../../src/commands/devCiFailures.js';

function capture(): { out: string[]; err: string[]; output: CiFailuresOutput } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, output: { write: (t) => out.push(t), error: (t) => err.push(t) } };
}

const FAILURE: CiAnnotation = {
  path: 'tests/unit/foo.test.ts',
  start_line: 42,
  annotation_level: 'failure',
  message: 'expected 1 to be 2',
};

/** A deps stub whose annotations call behaves per-check. */
function deps(annotationsFor: (checkId: number) => unknown | Promise<unknown>) {
  return {
    ghJson: async (args: string[]): Promise<unknown> => {
      if (args[0] === 'pr') return { headRefOid: 'abcdef1234567890' };
      if (args[1]?.includes('/check-runs?')) {
        return {
          check_runs: [
            { id: 1, name: 'Unit Tests (node 20)', conclusion: 'failure' },
            { id: 2, name: 'Unit Tests (node 22)', conclusion: 'failure' },
          ],
        };
      }
      const m = args[1]?.match(/check-runs\/(\d+)\/annotations/);
      return annotationsFor(Number(m?.[1] ?? 0));
    },
  };
}

describe('extractFailureLines', () => {
  it('keeps real failures and drops runner noise', () => {
    const lines = extractFailureLines([
      FAILURE,
      { path: '.github/workflows/ci.yml', annotation_level: 'failure', message: 'runner noise' },
      { path: 'x.ts', annotation_level: 'warning', message: 'a warning' },
      { path: 'y.ts', annotation_level: 'failure', message: 'Process completed with exit code 1.' },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('tests/unit/foo.test.ts:42');
  });
});

describe('runDevCiFailures — a failed read is not "no failures"', () => {
  it('THE DEFECT: every annotations read throws → says UNKNOWN, never "likely a build/lint step"', async () => {
    const { out, err, output } = capture();
    const code = await runDevCiFailures({
      pr: '1868',
      output,
      deps: deps(() => {
        throw new Error('annotations endpoint 502');
      }),
    });
    expect(code).toBe(0); // diagnostic, never a gate
    const stdout = out.join('\n');
    // It must NOT diagnose the nature of failures it could not see.
    expect(stdout).not.toContain('likely a build/lint/type step');
    expect(stdout).toMatch(/UNKNOWN/);
    // And it must name which checks went unread, on stderr.
    expect(err.join('\n')).toMatch(/Annotations NOT read for 2 of 2/);
  });

  it('CONTROL: genuine empty annotations still give the original build/lint diagnosis', async () => {
    const { out, err, output } = capture();
    const code = await runDevCiFailures({ pr: '1868', output, deps: deps(() => []) });
    expect(code).toBe(0);
    // This half passes BOTH before and after the change. Without it, a guard that
    // always fired would look identical on the defect case and be wrong on every
    // genuinely-annotation-free run.
    expect(out.join('\n')).toContain('likely a build/lint/type step');
    expect(out.join('\n')).not.toMatch(/UNKNOWN/);
    expect(err.join('\n')).not.toMatch(/NOT read/);
  });

  it('a PARTIAL read prints the failures it has AND says the listing is incomplete', async () => {
    const { out, err, output } = capture();
    await runDevCiFailures({
      pr: '1868',
      output,
      deps: deps((id) => {
        if (id === 1) return [FAILURE];
        throw new Error('502');
      }),
    });
    // The failure it could read is reported…
    expect(out.join('\n')).toContain('tests/unit/foo.test.ts:42');
    // …and the gap is NOT hidden by the presence of findings.
    expect(err.join('\n')).toMatch(/Annotations NOT read for 1 of 2/);
    expect(err.join('\n')).toContain('Unit Tests (node 22)');
  });

  it('a non-array reply is absence of data, not zero annotations', async () => {
    for (const shape of [null, undefined, {}, 'oops', 42]) {
      const { out, err, output } = capture();
      await runDevCiFailures({ pr: '1868', output, deps: deps(() => shape) });
      expect(out.join('\n'), `shape ${JSON.stringify(shape)}`).not.toContain('likely a build/lint/type step');
      expect(err.join('\n'), `shape ${JSON.stringify(shape)}`).toMatch(/Annotations NOT read for 2 of 2/);
    }
  });
});
