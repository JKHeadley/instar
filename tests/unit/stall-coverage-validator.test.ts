// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Semantic boundary tests for the stall-coverage validator
 * (docs/specs/framework-stall-coverage-matrix.md §5 — both sides of every
 * hermetic boundary), over synthetic fixture trees with injected deps.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  validateStallMatrixFile,
  validateAllStallMatrices,
  type StallCoverageValidatorDeps,
  type StallMatrixResult,
} from '../../src/core/stallCoverageValidator.js';

const CLASS_IDS = ['alpha-class', 'beta-class'] as const;
const FRAMEWORK = 'test-cli';
const MATRIX_REL = `docs/frameworks/${FRAMEWORK}-stall-coverage.md`;

let root: string;

const deps: StallCoverageValidatorDeps = {
  guardManifestKeys: new Set(['monitoring.fake.enabled']),
  notAGuardComponents: new Map([['FakeClassifier', 'pure classifier with no switch']]),
  stallClassIds: CLASS_IDS,
  requiredFrameworks: [FRAMEWORK],
};

const EVIDENCE_OK =
  "import { detectAlpha } from '../../src/fake/Detector.js';\n" +
  '// stall-class: alpha-class\n' +
  '// stall-class: beta-class\n' +
  "it('fires', () => { expect(detectAlpha('ALPHA')).toBe(true); });\n";

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-validator-'));
  write('src/fake/Detector.ts', 'export function detectAlpha(t: string) { return t.includes("ALPHA"); }\n');
  write('src/fake/Recovery.ts', 'export class AlphaRecovery {}\n');
  write('tests/unit/alpha-evidence.test.ts', EVIDENCE_OK);
  write('tests/unit/flaky-evidence.test.ts', EVIDENCE_OK);
  write(
    'vitest.push.config.ts',
    'const FLAKY_TESTS = [\n' +
      "  // known-flaky, excluded from the push suite\n" +
      "  'tests/unit/flaky-evidence.test.ts',\n" +
      '];\n' +
      'export default defineConfig({\n' +
      '  test: {\n' +
      "    include: ['tests/unit/**/*.test.ts'],\n" +
      '    exclude: FLAKY_TESTS,\n' +
      '  },\n' +
      '});\n',
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

type Row = Record<string, unknown>;

function coveredRow(over: Row = {}): Row {
  return {
    class: 'alpha-class',
    status: 'covered',
    detector: 'src/fake/Detector.ts#detectAlpha',
    recovery: 'src/fake/Recovery.ts#AlphaRecovery',
    guardKey: 'monitoring.fake.enabled',
    posture: 'live',
    evidence: 'tests/unit/alpha-evidence.test.ts',
    'liveness-surface': 'registry reports the stalled state honestly',
    ...over,
  };
}

function gapRow(over: Row = {}): Row {
  return {
    class: 'beta-class',
    status: 'declared-gap',
    reason: 'no detector exists yet',
    issueRef: 'stallclass::beta-class::test-cli::gap',
    closePath: 'CMT-1',
    'liveness-surface': 'DEFECT: session reads as running while stalled',
    ...over,
  };
}

function validate(rows: Row[], now?: Date): StallMatrixResult {
  const doc = { framework: FRAMEWORK, 'stall-coverage': rows };
  write(MATRIX_REL, `---\n${yaml.dump(doc, { lineWidth: 120, noRefs: true, skipInvalid: true })}---\n\nbody\n`);
  return validateStallMatrixFile({ repoRoot: root, filePath: MATRIX_REL, now, deps });
}

function rules(r: StallMatrixResult): string[] {
  return r.issues.map((i) => i.rule);
}

describe('stallCoverageValidator — hermetic boundaries', () => {
  it('covered row with live symbols + marked, collected evidence passes', () => {
    const r = validate([coveredRow(), gapRow()]);
    expect(rules(r)).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.rowCount).toBe(2);
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('covered row with a dead symbol fails (missing export and missing file)', () => {
    expect(rules(validate([coveredRow({ detector: 'src/fake/Detector.ts#noSuchExport' }), gapRow()])))
      .toContain('symbol-unresolvable');
    expect(rules(validate([coveredRow({ recovery: 'src/fake/NoSuchFile.ts#AlphaRecovery' }), gapRow()])))
      .toContain('symbol-unresolvable');
  });

  it('detector === recovery fails', () => {
    const r = validate([
      coveredRow({ recovery: 'src/fake/Detector.ts#detectAlpha' }),
      gapRow(),
    ]);
    expect(rules(r)).toContain('detector-equals-recovery');
  });

  it('covered row without guardKey fails; unknown guardKey fails', () => {
    expect(rules(validate([coveredRow({ guardKey: undefined }), gapRow()])))
      .toContain('guard-key-missing');
    expect(rules(validate([coveredRow({ guardKey: 'monitoring.unknown.enabled' }), gapRow()])))
      .toContain('guard-key-unknown');
    expect(rules(validate([coveredRow({ guardKey: 'exempt:NotInManifest' }), gapRow()])))
      .toContain('guard-key-unknown');
  });

  it('manifest-exempt guardKey passes with a guard-exempt-vacuous warning', () => {
    const r = validate([coveredRow({ guardKey: 'exempt:FakeClassifier' }), gapRow()]);
    expect(rules(r)).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.warnings.map((w) => w.rule)).toContain('guard-exempt-vacuous');
  });

  it('covered posture must be live; covered-dark needs no posture but needs closePath', () => {
    expect(rules(validate([coveredRow({ posture: undefined }), gapRow()])))
      .toContain('posture-not-live');
    const dark = validate([
      coveredRow({ status: 'covered-dark', posture: undefined, closePath: 'CMT-2' }),
      gapRow(),
    ]);
    expect(rules(dark)).toEqual([]);
    const darkNoClose = validate([
      coveredRow({ status: 'covered-dark', posture: undefined }),
      gapRow(),
    ]);
    expect(rules(darkNoClose)).toContain('closepath-missing');
  });

  it('evidence lacking the detector identifier or the stall-class marker fails', () => {
    write(
      'tests/unit/evidence-no-ident.test.ts',
      '// stall-class: alpha-class\n// stall-class: beta-class\nit("x", () => {});\n',
    );
    expect(
      rules(validate([coveredRow({ evidence: 'tests/unit/evidence-no-ident.test.ts' }), gapRow()])),
    ).toContain('evidence-identifier-missing');

    write(
      'tests/unit/evidence-no-marker.test.ts',
      "import { detectAlpha } from '../../src/fake/Detector.js';\nit('x', () => {});\n",
    );
    expect(
      rules(validate([coveredRow({ evidence: 'tests/unit/evidence-no-marker.test.ts' }), gapRow()])),
    ).toContain('evidence-marker-missing');
  });

  it('evidence in FLAKY_TESTS fails — an excluded test proves nothing', () => {
    const r = validate([coveredRow({ evidence: 'tests/unit/flaky-evidence.test.ts' }), gapRow()]);
    expect(rules(r)).toContain('evidence-excluded-from-push-suite');
  });

  it('evidence outside the include globs fails as not-collected', () => {
    write('tests/fixtures/orphan-evidence.test.ts', EVIDENCE_OK);
    const r = validate([coveredRow({ evidence: 'tests/fixtures/orphan-evidence.test.ts' }), gapRow()]);
    expect(rules(r)).toContain('evidence-not-collected');
  });

  it('evidence carrying a vitest skip-class modifier fails', () => {
    write('tests/unit/evidence-skipped.test.ts', EVIDENCE_OK + "it.skip('later', () => {});\n");
    const r = validate([coveredRow({ evidence: 'tests/unit/evidence-skipped.test.ts' }), gapRow()]);
    expect(rules(r)).toContain('evidence-skip-marked');
  });

  it('declared-gap with well-formed refs passes; missing or bad-charset refs fail', () => {
    expect(rules(validate([coveredRow(), gapRow()]))).toEqual([]);
    expect(rules(validate([coveredRow(), gapRow({ issueRef: undefined })])))
      .toContain('issueref-missing');
    expect(rules(validate([coveredRow(), gapRow({ closePath: undefined })])))
      .toContain('closepath-missing');
    expect(rules(validate([coveredRow(), gapRow({ issueRef: 'Bad_Ref!' })])))
      .toContain('issueref-charset-invalid');
    expect(rules(validate([coveredRow(), gapRow({ closePath: 'has space' })])))
      .toContain('closepath-charset-invalid');
  });

  it('pending-mint without seededAt fails; with seededAt it passes', () => {
    expect(rules(validate([coveredRow(), gapRow({ closePath: 'pending-mint' })])))
      .toContain('pending-mint-without-seededat');
    const now = new Date('2026-01-05T12:00:00Z');
    const ok = validate(
      [
        coveredRow(),
        gapRow({
          closePath: 'pending-mint',
          seededAt: '2026-01-01',
          reason: 'new-class, unreviewed',
        }),
      ],
      now,
    );
    expect(rules(ok)).toEqual([]);
  });

  it('a future-dated seededAt fails — future-dating cannot stall the aging clock', () => {
    const now = new Date('2026-01-05T12:00:00Z');
    const r = validate(
      [coveredRow(), gapRow({ seededAt: '2026-02-01', reason: 'new-class, unreviewed' })],
      now,
    );
    expect(rules(r)).toContain('seeded-at-future-dated');
  });

  it('unreviewed aging ratchet: +61d fails, +46d warns only, +10d clean', () => {
    const seeded = gapRow({
      closePath: 'pending-mint',
      seededAt: '2026-01-01',
      reason: 'new-class, unreviewed',
    });
    const aged = validate([coveredRow(), { ...seeded }], new Date('2026-03-03T12:00:00Z'));
    expect(rules(aged)).toContain('unreviewed-aged-out');

    const aging = validate([coveredRow(), { ...seeded }], new Date('2026-02-16T12:00:00Z'));
    expect(rules(aging)).toEqual([]);
    expect(aging.warnings.map((w) => w.rule)).toContain('unreviewed-aging');

    const young = validate([coveredRow(), { ...seeded }], new Date('2026-01-11T12:00:00Z'));
    expect(rules(young)).toEqual([]);
    expect(young.warnings.map((w) => w.rule)).not.toContain('unreviewed-aging');
  });

  it('clearing unreviewed requires an acceptanceRef (label-flipping is not review)', () => {
    const now = new Date('2026-01-05T12:00:00Z');
    const cleared = validate(
      [coveredRow(), gapRow({ seededAt: '2026-01-01', reason: 'reviewed and accepted as a gap' })],
      now,
    );
    expect(rules(cleared)).toContain('unreviewed-cleared-without-acceptance');

    const accepted = validate(
      [
        coveredRow(),
        gapRow({
          seededAt: '2026-01-01',
          reason: 'reviewed and accepted as a gap',
          acceptanceRef: 'ACC:2026-01-04:overseer',
        }),
      ],
      now,
    );
    expect(rules(accepted)).toEqual([]);
  });

  it('not-applicable needs reason AND revalidateOn', () => {
    const na = {
      class: 'beta-class',
      status: 'not-applicable',
      reason: 'stateless CLI: no persistent transcript exists to wedge',
      revalidateOn: 'framework version or transport change',
      'liveness-surface': 'n/a — the state is structurally unreachable',
    };
    expect(rules(validate([coveredRow(), na]))).toEqual([]);
    expect(rules(validate([coveredRow(), { ...na, revalidateOn: undefined }])))
      .toContain('revalidateon-missing');
    expect(rules(validate([coveredRow(), { ...na, reason: undefined }])))
      .toContain('reason-missing');
  });

  it('missing class row fails; unknown class fails; duplicate class fails', () => {
    const missing = validate([coveredRow()]);
    expect(rules(missing)).toContain('class-row-missing');
    expect(missing.issues.find((i) => i.rule === 'class-row-missing')?.classId).toBe('beta-class');

    expect(rules(validate([coveredRow(), gapRow(), gapRow({ class: 'gamma-class' })])))
      .toContain('class-unknown');

    expect(rules(validate([coveredRow(), gapRow(), coveredRow()])))
      .toContain('class-duplicate');
  });

  it('a `..` path segment is rejected before any read', () => {
    expect(
      rules(validate([coveredRow({ detector: 'src/fake/../fake/Detector.ts#detectAlpha' }), gapRow()])),
    ).toContain('path-traversal-rejected');
    expect(
      rules(validate([coveredRow({ evidence: 'tests/unit/../unit/alpha-evidence.test.ts' }), gapRow()])),
    ).toContain('path-traversal-rejected');
  });

  it('an oversize matrix file is rejected', () => {
    const pad = '#'.repeat(300 * 1024);
    write(MATRIX_REL, `---\nframework: ${FRAMEWORK}\n'stall-coverage': []\n---\n${pad}\n`);
    const r = validateStallMatrixFile({ repoRoot: root, filePath: MATRIX_REL, deps });
    expect(rules(r)).toContain('matrix-file-too-large');
  });

  it('the framework field must match the filename-derived framework', () => {
    const doc = { framework: 'some-other-cli', 'stall-coverage': [coveredRow(), gapRow()] };
    write(MATRIX_REL, `---\n${yaml.dump(doc, { noRefs: true, skipInvalid: true })}---\n`);
    const r = validateStallMatrixFile({ repoRoot: root, filePath: MATRIX_REL, deps });
    expect(rules(r)).toContain('framework-field-mismatch');
  });

  it('validateAllStallMatrices reports a missing required matrix file', () => {
    validate([coveredRow(), gapRow()]); // ensure test-cli matrix exists and is valid
    const set = validateAllStallMatrices({
      repoRoot: root,
      deps: { ...deps, requiredFrameworks: [FRAMEWORK, 'other-cli'] },
    });
    expect(set.valid).toBe(false);
    expect(set.issues.map((i) => i.rule)).toContain('matrix-file-missing');
    expect(set.results.some((r) => r.framework === FRAMEWORK && r.valid)).toBe(true);
  });

  it('refusal messages never echo rejected raw field content', () => {
    const MARKER = 'XZQMARKERQZX';
    const r = validate([
      {
        class: `${MARKER}-class`,
        status: `covered-${MARKER}`,
        detector: `src/${MARKER}/../evil.ts#${MARKER}`,
        recovery: `bad charset ${MARKER}!`,
        guardKey: `monitoring.${MARKER}.enabled`,
        evidence: `tests/unit/${MARKER}.test.ts`,
        issueRef: `${MARKER}_BAD!`,
        closePath: `${MARKER} spaced`,
        seededAt: `${MARKER}`,
        reason: `${MARKER} `.repeat(40),
        'liveness-surface': '',
        matchedClasses: [`${MARKER}-x`],
      },
      coveredRow(),
      gapRow(),
    ]);
    expect(r.valid).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
    for (const issue of [...r.issues, ...r.warnings]) {
      expect(issue.message).not.toContain(MARKER);
    }
  });
});
