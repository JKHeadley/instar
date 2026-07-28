/**
 * Unit tests for the decision-point classification gate in
 * write-convergence-tag.mjs (ownership-gated-spawn-and-judgment-within-floors
 * §3.6 / FD12 — the Judgment Within Floors standard's process hook).
 *
 * The tag writer must REFUSE to stamp `review-convergence` while the spec's
 * `## Decision points touched` section is missing or carries a row without a
 * classification (`invariant` | `judgment-candidate`). Structural — prose
 * can't skip it. `*(none)*` is the escape for genuinely decision-free specs;
 * GRANDFATHERED_SLUGS (hardcoded, PR-extend-only) exempts specs already past
 * round 1 at gate-land time.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// The module is import-safe (main is guarded behind an argv check).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs module without type declarations
import { findDecisionPointGaps, GRANDFATHERED_SLUGS } from '../../skills/spec-converge/scripts/write-convergence-tag.mjs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SCRIPT = path.resolve(
  __dirname,
  '../../skills/spec-converge/scripts/write-convergence-tag.mjs',
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wct-dp-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/write-convergence-tag-decision-points.test.ts:afterEach',
  });
});

// ── findDecisionPointGaps (the parser) ────────────────────────────────────

describe('findDecisionPointGaps', () => {
  it('missing section → { ok: false, reason: missing-section }', () => {
    expect(findDecisionPointGaps('# T\n\n## Design\nstuff')).toEqual({ ok: false, reason: 'missing-section' });
  });

  it('present but EMPTY section → missing-section (an empty header satisfies nothing)', () => {
    const body = '## Decision points touched\n\n## Next\nx';
    expect(findDecisionPointGaps(body)).toEqual({ ok: false, reason: 'missing-section' });
  });

  it('*(none)* escape for a genuinely decision-free spec → ok', () => {
    expect(findDecisionPointGaps('## Decision points touched\n*(none)*\n')).toEqual({ ok: true });
  });

  it.each(['*(none)*', '(none)', 'None', 'None.', 'N/A', '_none_'])(
    'accepts the none-marker variant %s',
    (marker) => {
      expect(findDecisionPointGaps(`## Decision points touched\n${marker}\n`)).toEqual({ ok: true });
    },
  );

  it('every row classified (bullets) → ok', () => {
    const body = [
      '## Decision points touched',
      '- `SpawnAdmission.admit()` — **invariant** (one owner per conversation; enumerable domain)',
      '- `DuplicateSessionReconciler.intendedOwner()` — **judgment-candidate** (floor: evidence ladder; arbiter: J2 Increment 3)',
      '',
      '## Next',
    ].join('\n');
    expect(findDecisionPointGaps(body)).toEqual({ ok: true });
  });

  it('a table with per-row classifications → ok (header + separator rows are ignored by design)', () => {
    const body = [
      '## Decision points touched',
      '| Decision point | Classification |',
      '|---|---|',
      '| admit() | invariant |',
      '| intendedOwner() | judgment-candidate |',
      '',
      '## Next',
    ].join('\n');
    expect(findDecisionPointGaps(body)).toEqual({ ok: true });
  });

  it('one unclassified row → { ok: false, reason: unclassified } naming the row', () => {
    const body = [
      '## Decision points touched',
      '- `admit()` — invariant (enumerable domain)',
      '- `someNewGate()` — we will figure this out later',
      '',
      '## Next',
    ].join('\n');
    const r = findDecisionPointGaps(body);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unclassified');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toContain('someNewGate');
  });

  it('blockquote commentary and horizontal rules never count as rows', () => {
    const body = [
      '## Decision points touched',
      '> Classify each row per Judgment Within Floors.',
      '---',
      '- `admit()` — invariant',
      '',
      '## Next',
    ].join('\n');
    expect(findDecisionPointGaps(body)).toEqual({ ok: true });
  });

  it('only inspects the Decision points section, not the rest of the spec', () => {
    const body = [
      '## Decision points touched',
      '*(none)*',
      '',
      '## Discussion',
      '- an unclassified decision-ish bullet is fine outside the section',
    ].join('\n');
    expect(findDecisionPointGaps(body)).toEqual({ ok: true });
  });

  it('a grandfathered slug bypasses the gate entirely (hardcoded allowlist, PR-extend-only)', () => {
    GRANDFATHERED_SLUGS.push('legacy-spec');
    try {
      expect(findDecisionPointGaps('# no section at all', 'legacy-spec')).toEqual({ ok: true });
      expect(findDecisionPointGaps('# no section at all', 'not-grandfathered').ok).toBe(false);
    } finally {
      GRANDFATHERED_SLUGS.pop();
    }
  });

  it('ships with an EMPTY grandfathering allowlist (no spec is silently exempt)', () => {
    expect(GRANDFATHERED_SLUGS).toEqual([]);
  });
});

// ── end-to-end: the tag writer refuses / stamps ───────────────────────────

function writeFixture(decisionPointsSection: string | null): { spec: string; report: string } {
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
      '*(none)*',
      ...(decisionPointsSection === null ? [] : ['', '## Decision points touched', decisionPointsSection]),
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

describe('write-convergence-tag.mjs — decision-point gate (end-to-end)', () => {
  it('REFUSES the tag when the section is missing, with remediation text', () => {
    const { spec, report } = writeFixture(null);
    const r = runTag(spec, report);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Decision points touched');
    expect(r.out).toContain('Judgment Within Floors');
    // The spec was NOT stamped.
    expect(fs.readFileSync(spec, 'utf-8')).not.toContain('review-convergence');
  });

  it('REFUSES the tag on an unclassified row, naming it', () => {
    const { spec, report } = writeFixture('- `mysteryGate()` — TBD');
    const r = runTag(spec, report);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('unclassified');
    expect(r.out).toContain('mysteryGate');
    expect(fs.readFileSync(spec, 'utf-8')).not.toContain('review-convergence');
  });

  it('STAMPS the tag when every row is classified', () => {
    const { spec, report } = writeFixture('- `admit()` — invariant (enumerable domain)\n- `pickSurvivor()` — judgment-candidate (floor declared)');
    const r = runTag(spec, report);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(spec, 'utf-8')).toContain('review-convergence');
  });

  it('STAMPS the tag for a decision-free spec using the *(none)* escape', () => {
    const { spec, report } = writeFixture('*(none)*');
    const r = runTag(spec, report);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(spec, 'utf-8')).toContain('review-convergence');
  });
});
