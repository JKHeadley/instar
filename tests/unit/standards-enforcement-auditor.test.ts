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
  deriveAssessmentConfidence,
  computeInputHash,
  buildGuardTreeIndex,
  findMatchingGuardTree,
  probeGuardTree,
  stableView,
  type CoverageReport,
  containedRefPath,
} from '../../src/core/StandardsEnforcementAuditor.js';
import { resolveStandardsRegistry } from '../../src/core/standardsRegistryPath.js';

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
    const verified = gate.guards.filter((g) => g.refResolves).map((g) => g.ref);
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

  /**
   * `refResolutionRatio` is the same measurement under a name that states what it
   * measures. `enforcedRatio` is retained for existing readers and deprecated: its name
   * claims enforcement, while the value is the share of standards whose named reference
   * RESOLVES on disk.
   *
   * Pinned together deliberately. Two fields carrying one number will drift the moment
   * one of them is computed separately, and the deprecated name is the one that would be
   * left behind — so a reader on the old field would silently get a different number than
   * a reader on the new one. Both are asserted on the SAME report, including the
   * no-denominator case where the honest value is null rather than 0.
   */
  it('refResolutionRatio carries the same number as the deprecated enforcedRatio', () => {
    const report = computeCoverage({ registryPath, projectDir: repo });
    const { enforcedRatio, refResolutionRatio } = report.summary;

    expect(refResolutionRatio, 'the accurately-named field must be present').not.toBeUndefined();
    expect(refResolutionRatio).toBeCloseTo(4 / 7, 4);
    expect(refResolutionRatio, 'the two names must never disagree').toBe(enforcedRatio);
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

  /**
   * The failure this catches: the auditor's LOUDEST signal — "a standard cites a guard
   * that is gone" — suppressed by its own cache. `repoStructureSignal` probes only
   * immediate directory listings, so deleting a cited file under any second-level
   * directory left the key identical and the stale report was served for the process
   * lifetime, still saying the guard resolves.
   */
  it('the short-circuit RE-computes when a RESOLVED guard file disappears', () => {
    const r1 = computeCoverage({ registryPath, projectDir: repo });
    const ratchet = r1.standards.find((s) => s.standard === 'Ratchet Standard');
    expect(ratchet?.enforcementKind).toBe('ratchet');
    expect(ratchet?.danglingRefs).toEqual([]);

    // Delete the guard the registry names — nested under tests/unit/, exactly the shape
    // the directory-listing probe cannot see.
    fs.rmSync(path.join(repo, 'tests/unit/no-silent-llm-fallback.test.ts'));

    const r2 = computeCoverage({ registryPath, projectDir: repo }, r1);
    expect(r2, 'served a cached report over a deleted guard').not.toBe(r1);
    const after = r2.standards.find((s) => s.standard === 'Ratchet Standard');
    expect(after?.danglingRefs).toContain('tests/unit/no-silent-llm-fallback.test.ts');
    expect(after?.enforcementKind).toBe('documented-only');
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
    expect(osq!.guards.some((g) => g.ref === 'scripts/instar-dev-precommit.js' && g.refResolves)).toBe(true);
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
    expect(report.summary.assessmentConfidence).toBe('untrustworthy');
    expect(report.summary.confidenceReason).toMatch(/nothing was measured/i);
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
    // 2026-07-25, two hours after shipping the boolean: `true` here was the defect.
    // The LIVE agent-home registry carries 22 of 81 articles and passes EVERY internal
    // check — 22 headings, 22 parsed, nothing dropped, anchors present, above the floor —
    // because it is a perfectly self-consistent document that is a quarter of the real
    // one. So the boolean asserted trust over exactly what it was added to expose.
    // Nothing INSIDE a 22-rule document says it should have 81: trustworthiness needs an
    // outside expectation, and none exists yet. 'unverified' is the honest verdict even
    // for the FULL registry, and the deprecated boolean is false until one ships.
    expect(full.summary.assessmentConfidence).toBe('unverified');
    expect(full.summary.assessmentTrustworthy).toBe(false);
    expect(full.summary.confidenceReason).toMatch(/no integrity basis was supplied/i);
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
    expect(partial.summary.assessmentConfidence).toBe('untrustworthy');
    expect(partial.summary.registry.canaryFailures.length).toBeGreaterThan(0);
  });

  it('does not hash an unreadable registry identically to an empty one', () => {
    write('docs/BLANK.md', '');
    const blank = computeInputHash({ registryPath: path.join(repo, 'docs/BLANK.md'), projectDir: repo });
    const missing = computeInputHash({ registryPath: path.join(repo, 'docs/DOES-NOT-EXIST.md'), projectDir: repo });
    expect(missing).not.toBe(blank);
  });

  it('a COHERENT-BUT-STALE registry reads "unverified", never trustworthy (the live 22-of-81 case)', () => {
    // The defect this tri-state exists for, found 2026-07-25 two hours after shipping the
    // boolean. A stale registry is not malformed — it is a perfectly self-consistent
    // document that happens to be a fraction of the real one, so it passes EVERY internal
    // check: all headings parse, none dropped, anchors present, count above the floor.
    // The old boolean therefore said `true` over exactly the defect it was added to expose.
    const full = fs.readFileSync(REAL_REGISTRY, 'utf-8');
    // Take a genuinely coherent SUBSET: whole families, every rule intact.
    const cut = full.indexOf('## Building');
    write('docs/STALE.md', full.slice(0, cut > 0 ? cut : 20000));
    const report = computeCoverage({ registryPath: path.join(repo, 'docs/STALE.md'), projectDir: process.cwd() });

    // Internally consistent: nothing dropped, so no internal check can object.
    expect(report.summary.registry.droppedHeadings).toEqual([]);
    expect(report.summary.registry.parsed).toBe(report.summary.registry.articleHeadings);
    // And yet it is a fragment — so the verdict must NOT claim trust.
    expect(report.summary.assessmentTrustworthy).toBe(false);
    expect(report.summary.assessmentConfidence).not.toBe('verified');
    expect(report.summary.confidenceReason).toBeTruthy();
  });

  /**
   * WHY THIS TEST WAS REWRITTEN (ACT-1426) — read before "restoring" the old one.
   *
   * The previous version asserted a mismatched expectation produced
   * `untrustworthy`, and passed. It passed because it FABRICATED the mismatch by
   * hand: `{ sha256: 'aaa…', observedSha256: 'bbb…' }`. In production those two
   * values were the same number by construction — the route derived the
   * expectation from the resolution's own sha, and the resolver only ever returns
   * a sha past its `meta.sha256 !== observedSha` guard. So the branch the test
   * covered was unreachable, and `verified` was granted by a comparison that could
   * not fail.
   *
   * That is the lesson worth keeping: a unit test that constructs its own inputs
   * can cover a branch production can never enter, and the green tick then reads
   * as evidence the check works. The assertions below are therefore anchored to
   * the BASIS the resolver reports, which is the thing that actually varies.
   */
  it('deriveAssessmentConfidence: every verdict, anchored to the resolver basis', () => {
    const okRegistry = computeCoverage({ registryPath: REAL_REGISTRY, projectDir: process.cwd() }).summary.registry;

    // nothing measured
    expect(deriveAssessmentConfidence(0, okRegistry).confidence).toBe('untrustworthy');

    // an objecting canary
    const badCanary = { ...okRegistry, canaryOk: false, canaryFailures: ['a heading lost its rule'] };
    const bad = deriveAssessmentConfidence(81, badCanary);
    expect(bad.confidence).toBe('untrustworthy');
    expect(bad.reason).toMatch(/canary objected/i);

    // NO basis at all → unverified
    const un = deriveAssessmentConfidence(81, okRegistry);
    expect(un.confidence).toBe('unverified');
    expect(un.reason).toMatch(/no integrity basis was supplied/i);
    expect(un.reason).toMatch(/coherent older copy/i);

    // A CALLER-SUPPLIED path can never reach verified — this is the guarantee that
    // used to depend on the route remembering to withhold a field.
    const fixture = deriveAssessmentConfidence(81, okRegistry, { basis: 'caller-supplied-path' });
    expect(fixture.confidence).toBe('unverified');
    expect(fixture.reason).toMatch(/caller-supplied path/i);

    // The packed-meta basis with ALL THREE operands agreeing is the only route to
    // verified, and the reason states what that basis does and does not establish.
    const full = {
      basis: 'packed-meta-match' as const,
      metaSha256: 'aaaaaaaaaaaa0000aaaaaaaaaaaa0000aaaaaaaaaaaa0000aaaaaaaaaaaa0000',
      metaArticleCount: 81,
      observedArticleCount: 81,
      articleCountMatchesMeta: true,
      metaPackageVersion: '1.3.991',
      runningPackageVersion: '1.3.991',
      packageVersionMatches: true,
    };
    const ver = deriveAssessmentConfidence(81, okRegistry, full);
    expect(ver.confidence).toBe('verified');
    expect(ver.reason).toMatch(/currency/i);
    // It must NOT overclaim: not a runtime check against source, not tamper-proof.
    expect(ver.reason).toMatch(/not a runtime check/i);
    expect(ver.reason).toMatch(/not tamper-resistant/i);

    // VERSION SKEW — the operand the sha pair structurally cannot see. The generator
    // writes registry and meta on ADJACENT lines, so they agree forever however old
    // the asset is; `tsc` alone recompiles the reader without regenerating. Without
    // this operand, "current reader + arbitrarily old constitution" read as verified.
    const skew = deriveAssessmentConfidence(81, okRegistry, {
      ...full, metaPackageVersion: '1.3.900', packageVersionMatches: false,
    });
    expect(skew.confidence).toBe('unverified');
    expect(skew.reason).toMatch(/CROSS-VERSION skew/);
    // The reason must NOT overclaim: version equality does not prove currency, and
    // saying it did was the fourth instance of this design's recurring overclaim.
    expect(skew.reason).toMatch(/does NOT prove the asset is current/);
    expect(skew.reason).toMatch(/1\.3\.900/);

    // An UNSTAMPED asset (generated before the stamp existed) is an unknown operand,
    // not a pass. Absence must never read as presence.
    const unstamped = deriveAssessmentConfidence(81, okRegistry, {
      ...full, metaPackageVersion: null, packageVersionMatches: null,
    });
    expect(unstamped.confidence).toBe('unverified');
    expect(unstamped.reason).toMatch(/no package-version stamp/i);

    // A COUNT MISMATCH now DOWNGRADES rather than riding along as prose. The earlier
    // "diagnostic only, never invalidates" rule weighed a harm that does not exist —
    // the downgrade path is `unverified`, not a 503 — while discarding the only
    // genuine cross-artifact signal the system has.
    const drift = deriveAssessmentConfidence(79, okRegistry, {
      ...full, observedArticleCount: 79, articleCountMatchesMeta: false,
    });
    expect(drift.confidence).toBe('unverified');
    expect(drift.reason).toMatch(/read 79 article headings .* recorded 81/);
    expect(drift.reason).toMatch(/different builds/i);

    // An UNANALYZABLE guard tree is untrustworthy, not verified — the registry may be
    // perfectly sound while every enforcement figure describes a missing repository.
    const noTree = deriveAssessmentConfidence(81, okRegistry, full, {
      projectDir: '/tmp/not-instar',
      configuredProjectDir: '/tmp/not-instar',
      analyzable: false,
      markersFound: [],
      basis: 'configured-tree-unverified',
      freshnessVerified: false,
      freshnessReason: 'no matching source evidence',
      sourceIndexSha256: null,
      registrySha256: null,
      packageVersion: null,
    });
    expect(noTree.confidence).toBe('untrustworthy');
    expect(noTree.reason).toMatch(/not an analyzable instar source tree/i);
    expect(noTree.reason).toMatch(/missing repository rather than missing guards/i);

    // AND THE INVERSE, which is the half that was broken. `probeGuardTree` required a
    // `package.json#name === 'instar'` marker in its first version — so an agent home
    // (a full `src/` copy with NO package.json, which is the only deployment where this
    // surface is live) probed as unanalyzable FOREVER, making `untrustworthy` permanent
    // and `verified` unreachable outside a unit-test run in the checkout. A guard meant
    // to prevent a false `verified` had made the honest one impossible.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-'));
    try {
      fs.mkdirSync(path.join(home, 'src', 'server'), { recursive: true });
      fs.mkdirSync(path.join(home, 'src', 'core'), { recursive: true });
      fs.writeFileSync(path.join(home, 'src', 'server', 'routes.ts'), "router.get('/x',(q,s)=>{});\n");
      // Deliberately NO package.json — that is the shape of a real agent home.
      const probe = probeGuardTree(home);
      expect(probe.analyzable, 'an agent home with a real src/ tree must be analyzable').toBe(true);
      expect(probe.markersFound).toEqual(['src/server/routes.ts', 'src/core']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  /**
   * RATCHET — the tautology must not come back.
   *
   * `deriveAssessmentConfidence` may not perform an equality test between two
   * values that a single caller derives from one file. The structural expression
   * of that: its integrity parameter carries NO observed-sha field to compare
   * against, and the function body contains no sha comparison. Asserted over the
   * source because the behaviour is an absence, and an absence has no output to
   * assert on.
   */
  it('RATCHET: the confidence verdict performs no self-comparison', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src', 'core', 'StandardsEnforcementAuditor.ts'),
      'utf-8',
    );
    const fnStart = src.indexOf('export function deriveAssessmentConfidence');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('\n}', src.indexOf('{', fnStart));
    const body = src.slice(fnStart, fnEnd);

    // No re-hash, and no comparison of two shas — the resolver already did the
    // only comparison there is, and a second one here can only be circular.
    expect(body).not.toMatch(/createHash/);
    expect(body).not.toMatch(/observedSha/);
    expect(body).not.toMatch(/\.sha256\s*!==\s*/);
    // And the option that fed it is gone from the auditor's contract entirely.
    expect(src).not.toMatch(/expectation\?:\s*\{/);
  });

  /**
   * RATCHET, PART 2 — guard the file the tautology actually LIVED in.
   *
   * Review's sharpest observation about my own fix: the ratchet above scans
   * `deriveAssessmentConfidence`, but the tautology was never there. It was in the
   * ROUTE, which synthesised `expectation` from `resolution.sha256` and handed it
   * down. Ratcheting the consumer while leaving the producer unguarded is guarding
   * the exit the burglar already used.
   */
  it('RATCHET: the route hands the resolution through and synthesises no expectation', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'server', 'routes.ts'), 'utf-8');
    const start = src.indexOf('const conformanceReport');
    expect(start, 'conformanceReport closure not found — this ratchet is anchored to it').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("router.get('/conformance/coverage'", start));
    const code = body.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

    // No expectation may be constructed here, under that name or any other: the route
    // may only PASS THROUGH what the resolver established.
    expect(code).not.toMatch(/expectation/);
    expect(code).not.toMatch(/createHash/);
    expect(code).not.toMatch(/sha256\s*:/);

    // And it must pass the resolver's own fields, not values it derived itself.
    expect(code).toMatch(/registryMarkdown:\s*resolution\.markdown/);
    expect(code).toMatch(/integrity:\s*resolution\.integrity/);
  });

  /**
   * RATCHET, PART 3 — the verdict rule has exactly ONE home.
   *
   * `earnsVerified` lives beside the integrity type. If a consumer starts deciding
   * `verified` from its own conditionals, the rule silently forks and the downgrades
   * (version skew, count mismatch) stop applying wherever the fork lives.
   */
  it('RATCHET: no consumer decides `verified` for itself', () => {
    const root = process.cwd();
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts')) {
          if (full.endsWith('standardsRegistryPath.ts')) continue;
          const code = fs.readFileSync(full, 'utf-8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
          if (/packed-meta-match/.test(code) && !/earnsVerified/.test(code)) {
            offenders.push(path.relative(root, full));
          }
        }
      }
    };
    walk(path.join(root, 'src'));
    expect(
      offenders,
      `These files branch on the integrity basis without going through earnsVerified, so the ` +
        `version-skew and count-mismatch downgrades do not apply to them: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

describe('StandardsEnforcementAuditor — source freshness resolution', () => {
  beforeEach(buildFixture);

  it('rejects a landmark-complete stale tree and selects the checkout whose evidence matches', () => {
    const markdown = fs.readFileSync(registryPath, 'utf-8');
    const expected = buildGuardTreeIndex(repo, markdown, '9.9.9');
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'std-audit-stale-'));
    try {
      fs.cpSync(repo, stale, { recursive: true });
      fs.rmSync(path.join(stale, 'tests/unit/no-silent-llm-fallback.test.ts'));

      expect(probeGuardTree(stale).analyzable, 'the stale tree must pass the old landmark probe').toBe(true);
      expect(findMatchingGuardTree([stale, repo], expected, markdown, '9.9.9')).toBe(fs.realpathSync(repo));
    } finally {
      fs.rmSync(stale, { recursive: true, force: true });
    }
  });

  it('returns no checkout when every candidate is stale instead of blessing landmarks', () => {
    const markdown = fs.readFileSync(registryPath, 'utf-8');
    const expected = buildGuardTreeIndex(repo, markdown, '9.9.9');
    fs.rmSync(path.join(repo, 'tests/unit/no-silent-llm-fallback.test.ts'));

    expect(probeGuardTree(repo).analyzable).toBe(true);
    expect(findMatchingGuardTree([repo], expected, markdown, '9.9.9')).toBeNull();
  });

  it('the packed-source basis makes freshness independently checkable in the real report', () => {
    const resolution = resolveStandardsRegistry();
    expect(resolution.usable).toBe(true);
    if (!resolution.usable) return;

    const report = computeCoverage({
      registryPath: resolution.path,
      registryMarkdown: resolution.markdown,
      integrity: resolution.integrity,
      projectDir: process.cwd(),
    });
    expect(report.summary.guards.freshnessVerified).toBe(true);
    expect(report.summary.guards.sourceIndexSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(['executing-source-tree', 'source-tree-index-match']).toContain(report.summary.guards.basis);
    expect(report.summary.guards.projectDir).toBe(fs.realpathSync(process.cwd()));
    expect(report.summary.danglingCount).toBe(0);
  });
});


/**
 * Containment over registry-supplied refs.
 *
 * The refs probed here come from the constitution DOCUMENT, which after this change ships as
 * a packed asset and is mirrored into agent homes. An escaping ref is two defects at once: a
 * probe outside the audited tree, and — if the escaped path happens to exist — a standard
 * graded as ENFORCED against a file with nothing to do with this repository.
 */
describe('containedRefPath — registry refs cannot escape projectDir', () => {
  it('accepts an ordinary ref inside the tree', () => {
    expect(containedRefPath('/repo', 'src/core/Foo.ts')).toBe(path.resolve('/repo/src/core/Foo.ts'));
  });

  it('accepts the root itself', () => {
    expect(containedRefPath('/repo', '.')).toBe(path.resolve('/repo'));
  });

  it('REFUSES a traversal that climbs out of the tree', () => {
    expect(containedRefPath('/repo', '../../../etc/passwd')).toBeNull();
  });

  it('REFUSES an absolute ref pointing elsewhere', () => {
    expect(containedRefPath('/repo', '/etc/passwd')).toBeNull();
  });

  /**
   * The prefix-collision case a naive `startsWith(root)` gets wrong: `/repo-evil` shares a
   * string prefix with `/repo` and is NOT inside it. This is why the comparison appends a
   * separator, and this test is what would fail if someone simplified it back.
   */
  it('REFUSES a sibling directory that merely shares a name prefix', () => {
    expect(containedRefPath('/repo', '../repo-evil/x.ts')).toBeNull();
  });

  /**
   * A traversal that climbs out and back in IS contained — the resolved path is what matters,
   * not the presence of `..` in the text. Asserted so a future "reject any ref containing .."
   * shortcut is recognised as a different, blunter rule rather than an equivalent one.
   */
  it('accepts a path that leaves and returns, because resolution is what counts', () => {
    expect(containedRefPath('/repo', 'src/../src/core/Foo.ts')).toBe(path.resolve('/repo/src/core/Foo.ts'));
  });
});
