// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup; no git used here.
/**
 * Tier 1 (unit) tests for StandardsEnforcementAuditor (cartographer-conformance-audit
 * spec #3, Parts B + C). Builds a controlled fixture repo + registry to assert
 * verification + classification (ratchet > gate > lint > spec-only > documented-only),
 * dangling-ref detection (the loud signal), determinism/idempotency + the content-hash
 * short-circuit, and a canary over the REAL docs/STANDARDS-REGISTRY.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  computeCoverage,
  computeInputHash,
  stableView,
  type CoverageReport,
} from '../../src/core/StandardsEnforcementAuditor.js';

const REAL_REGISTRY = path.join(process.cwd(), 'docs/STANDARDS-REGISTRY.md');

let repo: string;
let registryPath: string;

function write(rel: string, content: string): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'std-audit-'));
  registryPath = path.join(repo, 'docs', 'STANDARDS-REGISTRY.md');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

/** A fixture registry exercising every classification path + a dangling ref. */
function buildFixture(): void {
  // Real guard files on disk.
  write('tests/unit/no-silent-llm-fallback.test.ts', '// ratchet\n');
  write('scripts/lint-foo.js', '// lint\n');
  write('src/core/MyGate.ts', 'export class MessagingToneGate {}\nexport const B16_UNVERIFIED_WALL = 1;\n');
  write('docs/specs/some-spec.md', '# spec\n');
  write('src/server/routes.ts', "router.get('/live/route', (req,res)=>{});\n");

  const md = [
    '## Building',
    '',
    '### Ratchet Standard',
    '**Rule.** r1.',
    '**In practice.** A forward ratchet (`tests/unit/no-silent-llm-fallback.test.ts`) fails CI.',
    '',
    '### Lint Standard',
    '**Rule.** r2.',
    '**Applied through.** Enforced by `scripts/lint-foo.js`.',
    '',
    '### Gate Standard',
    '**Rule.** r3.',
    '**Applied through.** Enforced by `B16_UNVERIFIED_WALL` in `MessagingToneGate`.',
    '',
    '### Route Standard',
    '**Rule.** r4.',
    '**Applied through.** The route `GET /live/route` serves it.',
    '',
    '### Spec Only Standard',
    '**Rule.** r5.',
    '**Applied through.** Designed in `docs/specs/some-spec.md`.',
    '',
    '### Gap Standard',
    '**Rule.** r6.',
    '**In practice.** Someone just has to remember this.',
    '',
    '### Dangling Standard',
    '**Rule.** r7.',
    '**Applied through.** Enforced by `tests/unit/this-was-removed.test.ts`.',
    '',
  ].join('\n');
  write('docs/STANDARDS-REGISTRY.md', md);
}

describe('StandardsEnforcementAuditor — verification + classification', () => {
  beforeEach(buildFixture);

  function find(report: CoverageReport, name: string) {
    const s = report.standards.find((x) => x.standard === name);
    expect(s, name).toBeTruthy();
    return s!;
  }

  it('classifies each standard by its strongest VERIFIED guard', () => {
    const report = computeCoverage({ registryPath, projectDir: repo });
    expect(find(report, 'Ratchet Standard').enforcementKind).toBe('ratchet');
    expect(find(report, 'Lint Standard').enforcementKind).toBe('lint');
    expect(find(report, 'Gate Standard').enforcementKind).toBe('gate');
    expect(find(report, 'Route Standard').enforcementKind).toBe('gate'); // a route is a gate-strength guard
    expect(find(report, 'Spec Only Standard').enforcementKind).toBe('spec-only');
    expect(find(report, 'Gap Standard').enforcementKind).toBe('documented-only');
  });

  it('a verified marker + class both resolve to verified guards', () => {
    const report = computeCoverage({ registryPath, projectDir: repo });
    const gate = find(report, 'Gate Standard');
    const verified = gate.guards.filter((g) => g.verified).map((g) => g.ref);
    expect(verified).toContain('B16_UNVERIFIED_WALL');
    expect(verified).toContain('MessagingToneGate');
    expect(gate.danglingRefs).toEqual([]);
  });

  it('records a named-but-absent ref as a DANGLING ref (the loud signal)', () => {
    const report = computeCoverage({ registryPath, projectDir: repo });
    const dangling = find(report, 'Dangling Standard');
    expect(dangling.danglingRefs).toContain('tests/unit/this-was-removed.test.ts');
    // No verified guard → it falls back to documented-only.
    expect(dangling.enforcementKind).toBe('documented-only');
    expect(report.summary.danglingCount).toBeGreaterThanOrEqual(1);
  });

  it('a standard with no enforcement reference at all is a documented-only gap', () => {
    const report = computeCoverage({ registryPath, projectDir: repo });
    expect(report.summary.gaps).toContain('Gap Standard');
  });

  it('the summary tallies byKind + enforcedRatio correctly', () => {
    const report = computeCoverage({ registryPath, projectDir: repo });
    const { byKind, total, enforcedRatio } = report.summary;
    expect(total).toBe(7);
    expect(byKind.ratchet).toBe(1);
    expect(byKind.lint).toBe(1);
    expect(byKind.gate).toBe(2);       // Gate + Route
    expect(byKind['spec-only']).toBe(1);
    expect(byKind['documented-only']).toBe(2); // Gap + Dangling
    // enforced = ratchet+gate+lint = 1+2+1 = 4 of 7
    expect(enforcedRatio).toBeCloseTo(4 / 7, 4);
  });
});

describe('StandardsEnforcementAuditor — determinism + short-circuit', () => {
  beforeEach(buildFixture);

  it('two runs over the same registry+repo produce a byte-identical stable view', () => {
    const r1 = computeCoverage({ registryPath, projectDir: repo });
    const r2 = computeCoverage({ registryPath, projectDir: repo });
    expect(JSON.stringify(stableView(r1))).toBe(JSON.stringify(stableView(r2)));
  });

  it('the input hash is stable across runs and changes when the registry changes', () => {
    const h1 = computeInputHash({ registryPath, projectDir: repo });
    const h2 = computeInputHash({ registryPath, projectDir: repo });
    expect(h1).toBe(h2);
    fs.appendFileSync(registryPath, '\n### New One\n**Rule.** r.\n');
    const h3 = computeInputHash({ registryPath, projectDir: repo });
    expect(h3).not.toBe(h1);
  });

  it('the content-hash short-circuit returns the prior report when inputs are unchanged', () => {
    const r1 = computeCoverage({ registryPath, projectDir: repo });
    const r2 = computeCoverage({ registryPath, projectDir: repo }, r1);
    expect(r2).toBe(r1); // identity — recompute was skipped
  });

  it('the short-circuit RE-computes when the registry content changed', () => {
    const r1 = computeCoverage({ registryPath, projectDir: repo });
    fs.appendFileSync(registryPath, '\n### Added Gap\n**Rule.** r.\n**In practice.** remember.\n');
    const r2 = computeCoverage({ registryPath, projectDir: repo }, r1);
    expect(r2).not.toBe(r1);
    expect(r2.summary.total).toBe(r1.summary.total + 1);
  });
});

describe('StandardsEnforcementAuditor — real-registry canary', () => {
  it('classifies the live constitution with a known-enforced standard as ratchet + a sane enforced ratio', () => {
    const report = computeCoverage({ registryPath: REAL_REGISTRY, projectDir: process.cwd() });
    // The "No Silent Degradation to Brittle Fallback" standard names its
    // tests/unit/no-silent-llm-fallback.test.ts forward ratchet — must classify ratchet.
    const nsd = report.standards.find((s) => s.standard.includes('No Silent Degradation'));
    expect(nsd, 'No Silent Degradation article').toBeTruthy();
    expect(nsd!.enforcementKind).toBe('ratchet');

    // A sane enforced-ratio band — catches a parser/extractor break (all-zero or all-one).
    expect(report.summary.total).toBeGreaterThanOrEqual(15);
    expect(report.summary.enforcedRatio).toBeGreaterThan(0.1);
    expect(report.summary.enforcedRatio).toBeLessThan(0.95);

    // The audit produces REAL, non-empty output on day one (the actual gap set).
    expect(report.summary.gaps.length).toBeGreaterThan(0);
    // A clean checkout has zero dangling refs (the registry cites only real guards).
    expect(report.summary.danglingCount).toBe(0);
  });

  it('classifies "Operator-Surface Quality" as a GATE (its named precommit guard resolves), not documented-only', () => {
    // CMT-1434: the standard must land as an ENFORCED gate, not prose. It names
    // scripts/instar-dev-precommit.js (the side-effects review gate) — a guard
    // that resolves on disk and classifies as gate-strength.
    const report = computeCoverage({ registryPath: REAL_REGISTRY, projectDir: process.cwd() });
    const osq = report.standards.find((s) => s.standard === 'Operator-Surface Quality');
    expect(osq, 'Operator-Surface Quality article').toBeTruthy();
    expect(osq!.enforcementKind).toBe('gate');
    expect(osq!.danglingRefs).toEqual([]); // every named guard resolves
    expect(osq!.guards.some((g) => g.ref === 'scripts/instar-dev-precommit.js' && g.verified)).toBe(true);
  });

  it('refuses a ratio when there is nothing to divide by, and carries its denominator', () => {
    // honest-denominators instance 4/6 (2026-07-25): `total === 0 ? 0 : ...` reported
    // "0% of standards enforced" for a registry that contributed NO standards at all.
    // Zero problems and zero data produced the same number, and the number was a
    // measurement nobody had taken. Nothing-measured must read as null, not as 0.
    write('docs/EMPTY-REGISTRY.md', '## Why this exists\n\nProse only. No articles.\n');
    const emptyRegistry = path.join(repo, 'docs/EMPTY-REGISTRY.md');
    const report = computeCoverage({ registryPath: emptyRegistry, projectDir: repo });

    expect(report.summary.total).toBe(0);
    expect(report.summary.enforcedRatio).toBeNull();
    expect(report.summary.assessmentTrustworthy).toBe(false);
    expect(report.summary.registry.articleHeadings).toBe(0);
    expect(report.summary.registry.parsed).toBe(0);
    expect(report.summary.registry.path).toBe(emptyRegistry);
    expect(report.summary.registry.bytes).toBeGreaterThan(0);
  });

  it('states the denominator + trustworthiness on a REAL pass, so a fragment cannot pose as the whole', () => {
    // The live defect this closes: the audit read a 22-article COPY of the registry
    // while the source carried 81, and reported 0.0455 with nothing beside it saying
    // what it had divided by. Both figures are now inseparable from the ratio.
    const full = computeCoverage({ registryPath: REAL_REGISTRY, projectDir: process.cwd() });
    expect(full.summary.assessmentTrustworthy).toBe(true);
    expect(full.summary.registry.parsed).toBe(full.summary.total);
    expect(full.summary.registry.articleHeadings).toBe(full.summary.total);
    expect(full.summary.registry.droppedHeadings).toEqual([]);
    expect(full.summary.registry.canaryOk).toBe(true);
    expect(full.summary.registry.families.length).toBeGreaterThanOrEqual(6);

    // A FRAGMENT of the same constitution: a ratio is still computed (it is real
    // arithmetic over what was read) but the denominator makes the fragment visible.
    const fragment = fs.readFileSync(REAL_REGISTRY, 'utf-8').split('\n').slice(0, 400).join('\n');
    write('docs/FRAGMENT-REGISTRY.md', fragment);
    const partial = computeCoverage({ registryPath: path.join(repo, 'docs/FRAGMENT-REGISTRY.md'), projectDir: process.cwd() });
    expect(partial.summary.total).toBeLessThan(full.summary.total);
    expect(partial.summary.registry.parsed).toBe(partial.summary.total);
    // The canary's anchor + floor checks catch the truncation → not trustworthy.
    expect(partial.summary.assessmentTrustworthy).toBe(false);
    expect(partial.summary.registry.canaryFailures.length).toBeGreaterThan(0);
  });

  it('does not hash an unreadable registry identically to an empty one', () => {
    write('docs/BLANK.md', '');
    const blank = computeInputHash({ registryPath: path.join(repo, 'docs/BLANK.md'), projectDir: repo });
    const missing = computeInputHash({ registryPath: path.join(repo, 'docs/DOES-NOT-EXIST.md'), projectDir: repo });
    expect(missing).not.toBe(blank);
  });
});
