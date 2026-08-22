// Self-test for the Standard-A deterministic marker floor
// (scripts/lint-machine-local-justification.js), the no-LLM parser that grades
// the `machine-local-justification: <taxonomy-key>` marker per
// docs/specs/three-standards-enforcement.md §178-202. It must:
//   - PASS a well-defended machine-local surface (valid taxonomy key in the
//     `## Multi-machine posture` section),
//   - PASS an operator-ratified-exception that cites a resolvable ref,
//   - FAIL (strict) an undefended machine-local assertion (rule A1),
//   - FAIL (strict) the reverse direction — a spurious/malformed marker: an
//     out-of-taxonomy key and an operator-ratified-exception with no ref (rule A2),
//   - ship REPORT-FIRST: a finding is a non-blocking signal (exit 0) unless
//     --strict is passed.
//
// Amendments 3 and 5 (ratified 2026-08-22, operator directive topic 52222) added
// per-key contracts, and every arm is covered below:
//   - physical-credential-locality NARROWED — must NAME its basis (a prohibiting
//     authority OR a technical impossibility) and declare permanence; a TEMPORARY
//     barrier must also record an exit, a re-review date inside the horizon, and
//     the date it was first declared, under a total-lifetime cap. The
//     pre-amendment bare form now fails — a deliberate tightening, so the case
//     that used to pass gets its own negative fixture rather than being deleted.
//   - migrating-to-unified ADDED — must cite the ratified destination and tracked
//     delivery, and carry `since` + `expires`. Expired, beyond-horizon, and
//     past-total-lifetime each fail separately. Those arms are what make the key
//     self-terminating instead of merely renewable.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
// @ts-expect-error — plain-JS gate script, no type declarations
import { findPostureSection } from '../../scripts/lint-machine-local-justification.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const LINT = path.join(REPO_ROOT, 'scripts', 'lint-machine-local-justification.js');
const FIX = path.join(REPO_ROOT, 'tests', 'fixtures', 'spec-lint');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runLint(...args: string[]): RunResult {
  // spawnSync captures BOTH streams regardless of exit code — needed to inspect
  // the report-mode (exit 0) findings that print to stderr.
  const r = spawnSync('node', [LINT, ...args], { encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const fx = (name: string) => path.join(FIX, name);

/** An ISO date `n` days from now — so a passing fixture never rots into a failure. */
function daysFromNow(n: number): string {
  const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Write a throwaway spec carrying one marker line. Kept out of the repo tree so
 *  the fixture directory holds only stable, checked-in cases. */
function tmpSpec(markerLine: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-marker-lint-'));
  const file = path.join(dir, 'spec.md');
  fs.writeFileSync(
    file,
    ['# Fixture spec', '', '## Multi-machine posture', '', 'This surface is machine-local.', '', markerLine, ''].join('\n'),
  );
  return file;
}

describe('lint-machine-local-justification (Standard A marker floor)', () => {
  // ── Positive cases ──
  it('PASSES a defended machine-local surface with a valid taxonomy key', () => {
    const r = runLint('--strict', fx('A-good-defended.md'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('clean');
  });

  it('PASSES an operator-ratified-exception that cites a resolvable ref', () => {
    const r = runLint('--strict', fx('A-good-ratified.md'));
    expect(r.code).toBe(0);
  });

  // ── Negative case (rule A1 — undefended machine-local) ──
  it('FAILS (strict) an undefended machine-local assertion', () => {
    const r = runLint('--strict', fx('A-bad-undefended.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A1-undefended-machine-local');
  });

  // ── Bidirectional case (rule A2 — the reverse direction, a spurious marker) ──
  it('FAILS (strict) a spurious marker whose key is outside the closed taxonomy', () => {
    const r = runLint('--strict', fx('A-bad-spurious-key.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A2-invalid-taxonomy-key');
  });

  it('FAILS (strict) an operator-ratified-exception with no machine-verifiable ref', () => {
    const r = runLint('--strict', fx('A-bad-ratified-noref.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A2-unresolvable-ratification-ref');
  });

  // ── Numbered headings (2026-08-21) — a section number must not make the
  //    posture section invisible to the gate. An exact-text match skipped 32 of
  //    123 posture-carrying specs, which then passed a gate that never ran. ──
  it('FAILS (strict) an undefended machine-local assertion under a NUMBERED heading', () => {
    const r = runLint('--strict', fx('A-bad-undefended-numbered.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A1-undefended-machine-local');
  });

  it('PASSES a defended surface under a NUMBERED heading (section bounds still correct)', () => {
    const r = runLint('--strict', fx('A-good-defended-numbered.md'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('clean');
  });

  // ── Prose quotation vs declaration (2026-08-21) ──────────────────────────
  // A correction-heavy spec QUOTES markers, and paragraph wrapping puts the
  // quotation at line-start where it read as an out-of-section declaration (A3).
  // Found by running the widened gate on a real spec; no fixture had ever
  // contained a spec that talks about markers.
  it('PASSES a spec that quotes a marker in prose outside the posture section', () => {
    const r = runLint('--strict', fx('A-good-quotes-a-marker.md'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('clean');
  });

  it('still FAILS a genuine out-of-section declaration (the quotation fix is not a hole)', () => {
    const body = [
      '# Spec',
      '',
      '## 8. Multi-machine posture',
      '',
      'The ring is machine-local BY DESIGN.',
      '',
      '## 9. Elsewhere',
      '',
      'machine-local-justification: hardware-bound-resource',
      '',
    ].join('\n');
    // The fixture is written to an OS tmpdir, NOT into `FIX` under the repo:
    // SourceTreeGuard refuses every destructive fs op whose target resolves
    // inside the instar source tree, so the cleanup below threw
    // SourceTreeGuardError and failed the test on CI. The lint takes an explicit
    // path argument, so the file's location is irrelevant to what is asserted.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-lint-'));
    const tmp = path.join(tmpDir, 'A-tmp-out-of-section.md');
    fs.writeFileSync(tmp, body);
    try {
      const r = runLint('--strict', tmp);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/A1-undefended-machine-local|A2-marker-outside-posture-section/);
    } finally {
      SafeFsExecutor.safeRmSync(tmpDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/lint-machine-local-justification.test.ts:cleanup',
      });
    }
  });

  // ── Heading-shape coverage (2026-08-21) ──────────────────────────────────
  // The section was located by an EXACT heading match, so any ordinary heading
  // ordinal or qualifier made the section invisible and the spec passed a gate
  // that never ran on it — 91 of 149 posture-carrying specs were seen. These are
  // the shapes measured in the real corpus; each must resolve to a section.
  describe('findPostureSection sees every heading shape in the corpus', () => {
    const shapes: Array<[string, string]> = [
      ['bare', '## Multi-machine posture'],
      ['numeric ordinal', '## 8. Multi-machine posture'],
      ['dotted ordinal', '## 8.2 Multi-machine posture'],
      ['section-mark ordinal', '## §4. Multi-machine posture (Phase A)'],
      ['letter ordinal', '#### D. Multi-machine posture — released-no-placement ONLY'],
      ['phrase not leading', '## 4. State and multi-machine posture'],
      ['phrase parenthesised', '## Cross-Machine Coherence (multi-machine posture)'],
    ];

    for (const [label, heading] of shapes) {
      it(`sees a ${label} heading`, () => {
        const body = `# Spec\n\nPrelude.\n\n${heading}\n\nmachine-local BY DESIGN.\n\n## Next\n\nAfter.\n`;
        const found = findPostureSection(body) as { start: number; end: number } | null;
        expect(found).not.toBeNull();
        const section = body.slice(found!.start, found!.end);
        expect(section).toContain('machine-local BY DESIGN');
        // Bounds still stop at the next equal-or-higher heading.
        expect(section).not.toContain('After.');
      });
    }

    it('returns null when there is no posture heading at all', () => {
      expect(findPostureSection('# Spec\n\nProse mentioning multi-machine posture inline.\n')).toBeNull();
    });

    it('prefers the canonical heading over an incidental one, whatever the order', () => {
      const body =
        '# Spec\n\n## Why the multi-machine posture check missed headings\n\nBackground.\n\n' +
        '## 8. Multi-machine posture\n\nmachine-local BY DESIGN.\n';
      const found = findPostureSection(body) as { start: number; end: number } | null;
      expect(found).not.toBeNull();
      expect(body.slice(found!.start, found!.end)).toContain('machine-local BY DESIGN');
    });
  });

  // ── Report-first rollout mode ──
  it('is REPORT-FIRST: a finding is a non-blocking signal (exit 0) without --strict', () => {
    const r = runLint(fx('A-bad-undefended.md'));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('A1-undefended-machine-local');
  });

  // ── JSON surface (deterministic, machine-readable) ──
  it('emits deterministic JSON findings under --json', () => {
    const r = runLint('--json', fx('A-bad-spurious-key.md'));
    const parsed = JSON.parse(r.stdout) as { findings: Array<{ rule: string }> };
    expect(parsed.findings.some((f) => f.rule === 'A2-invalid-taxonomy-key')).toBe(true);
  });

  // ── Amendment 3 — physical-credential-locality, NARROWED ──
  it('PASSES physical-credential-locality that names an IMPOSSIBILITY and declares permanence', () => {
    const r = runLint('--strict', fx('A-good-defended.md'));
    expect(r.code).toBe(0);
  });

  it('PASSES a TEMPORARY barrier that records BOTH an exit and a re-review date', () => {
    const spec = tmpSpec(
      'machine-local-justification: physical-credential-locality ' +
        'prohibited-by="Anthropic terms of service" permanence=temporary ' +
        `exit=standards.multiMachine.apiKeyDoorwayExit since=${daysFromNow(-30)} expires=${daysFromNow(90)}`,
    );
    expect(runLint('--strict', spec).code).toBe(0);
  });

  it('FAILS (strict) a TEMPORARY barrier renewed past its total lifetime cap', () => {
    // Round 3 gave this key a deadline. A deadline WITHOUT a lifetime cap is
    // renewable every 180 days forever — the exact loophole round 3 had just
    // closed for migrating-to-unified, re-created one key over.
    const spec = tmpSpec(
      'machine-local-justification: physical-credential-locality prohibited-by="vendor terms" ' +
        `permanence=temporary exit=7b761e25a since=2024-01-01 expires=${daysFromNow(90)}`,
    );
    const r = runLint('--strict', spec);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A2-credential-locality-temporary-lifetime-exceeded');
  });

  it('FAILS (strict) a TEMPORARY barrier with an exit but NO re-review date', () => {
    // An exit with no deadline is a permanent barrier with paperwork. The newer
    // key carries a horizon; binding it more tightly than this one had no reason.
    const spec = tmpSpec(
      'machine-local-justification: physical-credential-locality ' +
        'prohibited-by="vendor terms" permanence=temporary exit=7b761e25a',
    );
    const r = runLint('--strict', spec);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A2-credential-locality-temporary-review-missing');
    expect(r.stderr).toContain('A2-credential-locality-temporary-no-since');
  });

  it('FAILS (strict) the pre-amendment BARE physical-credential-locality form', () => {
    // The exact marker that passed before 2026-08-22. A narrowing that does not
    // fail the case it narrowed has narrowed nothing.
    const r = runLint('--strict', fx('A-bad-credential-bare.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A2-credential-locality-no-authority');
    expect(r.stderr).toContain('A2-credential-locality-no-permanence');
  });

  it('withdraws the DEFENCE too: a bare credential marker no longer defends the posture', () => {
    // Not merely reportable — the surface must read as UNDEFENDED, or the new
    // requirement would be visible while the posture it governs still passed.
    const r = runLint('--json', fx('A-bad-credential-bare.md'));
    const parsed = JSON.parse(r.stdout) as { findings: Array<{ rule: string }> };
    expect(parsed.findings.some((f) => f.rule === 'A1-undefended-machine-local')).toBe(true);
  });

  it('FAILS (strict) a TEMPORARY barrier that records no exit', () => {
    // A barrier declared temporary with no tracked way out is a permanent
    // barrier wearing a temporary label.
    const r = runLint('--strict', fx('A-bad-credential-temporary-no-exit.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A2-credential-locality-temporary-no-exit');
  });

  it('PASSES an IMPOSSIBILITY basis with no prohibiting authority to cite', () => {
    // A hardware-bound key has no authority forbidding the move. Demanding one
    // was an inconsistent evidentiary bar, so `impossible-because` is accepted.
    const spec = tmpSpec(
      'machine-local-justification: physical-credential-locality ' +
        'impossible-because="the key is sealed in this machine\'s TPM and cannot be exported" ' +
        'permanence=permanent',
    );
    const r = runLint('--strict', spec);
    expect(r.code).toBe(0);
  });

  // ── Amendment 5 — migrating-to-unified ──
  it('PASSES migrating-to-unified with a ratified ref, a tracking ref and an in-horizon expiry', () => {
    // The expiry is COMPUTED, not hardcoded. A static future date is a time bomb:
    // it drifts past the horizon and then past its own expiry, and the test starts
    // failing for reasons that have nothing to do with the parser.
    const spec = tmpSpec(
      'machine-local-justification: migrating-to-unified ' +
        'ratified=standards.multiMachine.singleMachineSurvivability ' +
        'tracking=https://github.com/JKHeadley/instar/pull/1957 ' +
        `since=${daysFromNow(-30)} expires=${daysFromNow(30)}`,
    );
    const r = runLint('--strict', spec);
    expect(r.code).toBe(0);
  });

  it('FAILS (strict) a renewal that would carry the posture past its TOTAL lifetime cap', () => {
    // The horizon alone bounds ONE declaration. This marker is inside the horizon
    // and still refused, because `since` shows the posture has already run for
    // years — which is the difference between self-terminating and merely renewable.
    const spec = tmpSpec(
      'machine-local-justification: migrating-to-unified ratified=7b761e25a ' +
        `tracking=7b761e25a since=2024-01-01 expires=${daysFromNow(30)}`,
    );
    const r = runLint('--strict', spec);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A2-migrating-lifetime-exceeded');
  });

  it('FAILS (strict) migrating-to-unified with no `since` to bound its total lifetime', () => {
    const spec = tmpSpec(
      'machine-local-justification: migrating-to-unified ratified=7b761e25a ' +
        `tracking=7b761e25a expires=${daysFromNow(30)}`,
    );
    const r = runLint('--strict', spec);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A2-migrating-no-since');
  });

  it('FAILS (strict) a migrating-to-unified expiry beyond the maximum horizon', () => {
    // The exact marker the first draft shipped as its GOOD fixture. It passed,
    // which is how the renewable-not-self-terminating gap was found.
    const r = runLint('--strict', fx('A-bad-migrating-beyond-horizon.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A2-migrating-expiry-beyond-horizon');
  });

  it('FAILS (strict) migrating-to-unified missing its citations and expiry', () => {
    const r = runLint('--strict', fx('A-bad-migrating-incomplete.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A2-migrating-no-ratified-decision');
    expect(r.stderr).toContain('A2-migrating-no-tracking-ref');
    expect(r.stderr).toContain('A2-migrating-no-expiry');
    expect(r.stderr).toContain('A2-migrating-no-since');
  });

  it('FAILS (strict) a migrating-to-unified posture that has EXPIRED', () => {
    // The self-terminating arm. A fully-cited marker whose date has passed is a
    // finding, because the key may never lapse silently into a permanent posture.
    const r = runLint('--strict', fx('A-bad-migrating-expired.md'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('A2-migrating-expired');
  });
});
