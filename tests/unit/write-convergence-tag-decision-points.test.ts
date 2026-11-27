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

  it.each(['deterministic counts', 'fixed cap', 'invariant', 'enumerable domain'])(
    'rejects an invariant label with only %s instead of a basis and evidence', (reason) => {
      const row = `- newPerDay=1, newPerWeek=4, libraryMax=40 — invariant (${reason})`;
      expect(findDecisionPointGaps(`## Decision points touched\n${row}\n`)).toEqual({
        ok: false, reason: 'missing-invariant-evidence', rows: [row],
      });
    },
  );

  it.each([
    'basis: enumerable-domain; evidence:',
    'basis: ; evidence: deterministic counts',
    'basis: convenience; evidence: easier to count',
  ])('refuses incomplete or undeclared invariant basis: %s', (declaration) => {
    expect(findDecisionPointGaps(`## Decision points touched\n- cap — invariant; ${declaration}\n`).ok).toBe(false);
  });

  it.each([
    '| invariant enforcement | judgment-candidate | floor: read-only; arbiter: reviewer |',
    '- invariant enforcement — judgment-candidate (floor: read-only; arbiter: reviewer)',
  ])('classifies the field rather than a word in the decision name: %s', (row) => {
    expect(findDecisionPointGaps(`## Decision points touched\n${row}\n`)).toEqual({ ok: true });
  });

  it.each([
    '| judgment-candidate admission | invariant | deterministic counts |',
    '- judgment-candidate admission — invariant (deterministic counts)',
  ])('cannot hide a bare invariant behind a word in the decision name: %s', (row) => {
    expect(findDecisionPointGaps(`## Decision points touched\n${row}\n`)).toEqual({
      ok: false, reason: 'missing-invariant-evidence', rows: [row],
    });
  });

  it('reads an explicit classification-first bullet before labels mentioned in its evidence', () => {
    const row = '- invariant; evidence: judgment-candidate was considered';
    expect(findDecisionPointGaps(`## Decision points touched\n${row}\n`)).toEqual({
      ok: false, reason: 'missing-invariant-evidence', rows: [row],
    });
  });

  it('does not mistake a rejected invariant label in the rationale for the classification', () => {
    const row = '- growth — judgment-candidate; rejects the old invariant label; floor: read-only; arbiter: learning reviewer';
    expect(findDecisionPointGaps(`## Decision points touched\n${row}\n`)).toEqual({ ok: true });
  });

  it.each(['reviewer-decision-completeness.md', 'reviewer-lessons-aware.md'])(
    'ships an explicit evidence contest in the mandatory reviewer %s', (name) => {
      const prompt = fs.readFileSync(path.resolve(__dirname, '../../skills/spec-converge/templates', name), 'utf8');
      expect(prompt).toContain('FIXED_LIMIT_CONTEST');
      expect(prompt).toContain('judgment-candidate by default');
      expect(prompt).toContain('this exact boundary');
      expect(prompt).toContain('MATERIAL / DESIGN');
      expect(prompt).toContain('counterexample');
    },
  );

  it('accepts an independently evidenced external boundary', () => {
    const row = '- request size — invariant; basis: external-constraint; evidence: upstream API rejects payloads over its documented 4096-byte ceiling';
    expect(findDecisionPointGaps(`## Decision points touched\n${row}\n`)).toEqual({ ok: true });
  });

  it('every row classified (bullets) → ok', () => {
    const body = [
      '## Decision points touched',
      '- `SpawnAdmission.admit()` — **invariant**; basis: enumerable-domain; evidence: a conversation has exactly one lease owner in the ownership protocol',
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
      '| admit() | invariant | basis: enumerable-domain; evidence: ownership protocol permits one lease owner |',
      '| intendedOwner() | judgment-candidate |',
      '',
      '## Next',
    ].join('\n');
    expect(findDecisionPointGaps(body)).toEqual({ ok: true });
  });

  it('one unclassified row → { ok: false, reason: unclassified } naming the row', () => {
    const body = [
      '## Decision points touched',
      '- `admit()` — invariant; basis: enumerable-domain; evidence: ownership protocol permits one lease owner',
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
      '- `admit()` — invariant; basis: irreversible-consequence; evidence: duplicate owners can send conflicting external writes',
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
      // The maturation-plan gate REFUSES as of 2026-08-07 (Maturation Path clause
      // (a)); without this section the fixture would fail on THAT gate rather than
      // the decision-point gate under test here.
      '',
      '## Maturation plan',
      '',
      '- **test-agent-live:** immediately',
      '- **dev-agent-live:** after one clean soak day',
      '- **fleet:** after operator review',
      '- **graduation criterion:** stated',
      '- **dark-window:** 14d',
      '- **ladder:** monitoring.example',
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

  it('REFUSES the original growth-cap row and leaves convergence unstamped', () => {
    const { spec, report } = writeFixture('- newPerDay=1, newPerWeek=4, libraryMax=40 — invariant (deterministic counts)');
    const r = runTag(spec, report);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('basis:');
    expect(r.out).toContain('evidence:');
    expect(r.out).toContain('newPerDay');
    expect(fs.readFileSync(spec, 'utf-8')).not.toContain('review-convergence');
  });

  it('STAMPS the tag when every row is classified', () => {
    const { spec, report } = writeFixture('- `admit()` — invariant; basis: enumerable-domain; evidence: ownership protocol permits one lease owner\n- `pickSurvivor()` — judgment-candidate (floor declared)');
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
