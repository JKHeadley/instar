/**
 * Unit tests for the Decision-Completeness additions to write-convergence-tag.mjs
 * (Autonomy Principles Enforcement spec, Piece 2).
 *
 * Convergence criterion 2, enforced STRUCTURALLY: the tag writer refuses to stamp
 * `review-convergence` while `## Open questions` contains unresolved entries; on
 * success (with reviewer counts supplied) the spec earns `single-run-completable:
 * true` + the evidence counts — earned, not minted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// The module is import-safe (main is guarded behind an argv check).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs module without type declarations
import { findOpenQuestions } from '../../skills/spec-converge/scripts/write-convergence-tag.mjs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SCRIPT = path.resolve(
  __dirname,
  '../../skills/spec-converge/scripts/write-convergence-tag.mjs',
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wct-dc-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/write-convergence-tag-decision-completeness.test.ts:afterEach',
  });
});

function writeFixture(openQuestionsSection: string): { spec: string; report: string } {
  const eli16 = path.join(tmpDir, 'fixture.eli16.md');
  fs.writeFileSync(eli16, 'x'.repeat(900));
  const spec = path.join(tmpDir, 'fixture-spec.md');
  fs.writeFileSync(
    spec,
    [
      '---',
      'title: "fixture"',
      'slug: "fixture"',
      `eli16-overview: "${eli16}"`,
      '---',
      '# Fixture',
      '',
      '## Proposed design',
      'something',
      '',
      '## Open questions',
      openQuestionsSection,
      '',
      '## Non-goals',
      'nothing',
    ].join('\n'),
  );
  const report = path.join(tmpDir, 'report.md');
  fs.writeFileSync(report, '# report');
  return { spec, report };
}

function runTag(spec: string, report: string, extra: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync(
      'node',
      [SCRIPT, '--spec', spec, '--iterations', '2', '--report', report, ...extra],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stderr?: string; stdout?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('findOpenQuestions (criterion-2 parser)', () => {
  it('returns empty when there is no Open questions section', () => {
    expect(findOpenQuestions('# T\n\n## Design\nstuff')).toEqual([]);
  });

  it('treats none-markers and commentary as resolved', () => {
    const body = [
      '## Open questions',
      '> Per Principle 2 these must reach zero before convergence.',
      '*(none)*',
      '',
      '## Next',
    ].join('\n');
    expect(findOpenQuestions(body)).toEqual([]);
  });

  it.each(['*(none)*', '(none)', 'None', 'None.', 'N/A', '_none_'])(
    'accepts the none-marker variant %s',
    (marker) => {
      expect(findOpenQuestions(`## Open questions\n${marker}\n`)).toEqual([]);
    },
  );

  it('flags a live question bullet as unresolved', () => {
    const body = '## Open questions\n- **Q1:** A or B? (user to decide)\n';
    expect(findOpenQuestions(body)).toHaveLength(1);
  });

  it('only inspects the Open questions section, not the rest of the spec', () => {
    const body = [
      '## Open questions',
      '*(none)*',
      '',
      '## Discussion',
      '- a stray question? this is fine here',
    ].join('\n');
    expect(findOpenQuestions(body)).toEqual([]);
  });
});

describe('write-convergence-tag — structural open-questions gate', () => {
  it('REFUSES to stamp convergence while a user-decision is open', () => {
    const { spec, report } = writeFixture('- **Q1:** should we do A or B? (yours to decide)');
    const { code, out } = runTag(spec, report);
    expect(code).toBe(1);
    expect(out).toMatch(/cannot converge while a user-decision is still open/i);
    // and the tag was NOT written
    expect(fs.readFileSync(spec, 'utf-8')).not.toContain('review-convergence');
  });

  it('stamps convergence once the section reads (none)', () => {
    const { spec, report } = writeFixture('*(none)*');
    const { code } = runTag(spec, report);
    expect(code).toBe(0);
    expect(fs.readFileSync(spec, 'utf-8')).toContain('review-convergence');
  });
});

describe('write-convergence-tag — earned single-run-completable evidence', () => {
  it('writes the tag + counts when reviewer counts are supplied', () => {
    const { spec, report } = writeFixture('*(none)*');
    const { code } = runTag(spec, report, [
      '--frontloaded-decisions', '5',
      '--cheap-tags', '2',
      '--contested-cleared', '1',
    ]);
    expect(code).toBe(0);
    const fm = fs.readFileSync(spec, 'utf-8');
    expect(fm).toContain('single-run-completable: true');
    expect(fm).toContain('frontloaded-decisions: 5');
    expect(fm).toContain('cheap-to-change-tags: 2');
    expect(fm).toContain('contested-then-cleared: 1');
  });

  it('does NOT mint the tag when no counts are supplied (pre-reviewer specs stay honest)', () => {
    const { spec, report } = writeFixture('*(none)*');
    const { code } = runTag(spec, report);
    expect(code).toBe(0);
    expect(fs.readFileSync(spec, 'utf-8')).not.toContain('single-run-completable');
  });

  it('is idempotent — a re-run rewrites the fields without duplicating them', () => {
    const { spec, report } = writeFixture('*(none)*');
    runTag(spec, report, ['--frontloaded-decisions', '5', '--cheap-tags', '2', '--contested-cleared', '1']);
    runTag(spec, report, ['--frontloaded-decisions', '6', '--cheap-tags', '1', '--contested-cleared', '0']);
    const fm = fs.readFileSync(spec, 'utf-8');
    expect(fm.match(/single-run-completable/g)).toHaveLength(1);
    expect(fm).toContain('frontloaded-decisions: 6');
    expect(fm.match(/frontloaded-decisions/g)).toHaveLength(1);
  });
});
