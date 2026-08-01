// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup; no git used here.
/**
 * Tier 3 (E2E "feature is alive") test for the Standards Enforcement-Coverage Audit
 * (cartographer-conformance-audit spec #3).
 *
 *   PART A (the core proof): the REAL StandardsEnforcementAuditor computes coverage
 *   over the REAL docs/STANDARDS-REGISTRY.md + the REAL repo — producing a REAL,
 *   non-empty result on day one (the actual ~41 standards): a real enforced ratio in
 *   a sane band, a real (non-empty) gap list, and ZERO dangling refs on a clean
 *   checkout. A planted dangling ref in a fixture registry is surfaced. This proves
 *   the audit is wired to the real registry + real fs, not a no-op.
 *
 *   PART B (route alive): with the feature ENABLED in config, GET /conformance/
 *   coverage/health answers 200 (not 503) through the server + auth middleware.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeCoverage } from '../../src/core/StandardsEnforcementAuditor.js';
import { resolveStandardsRegistryFromPath } from '../../src/core/standardsRegistryPath.js';
import { parseStandardsRegistryDetailed } from '../../src/core/StandardsRegistryParser.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { CartographerTree } from '../../src/core/CartographerTree.js';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const AUTH = 'test-bearer-token';
const REAL_REGISTRY = path.join(process.cwd(), 'docs/STANDARDS-REGISTRY.md');

describe('Standards Enforcement-Coverage Audit — feature is alive (Tier 3 E2E)', () => {
  // ── PART A — the audit computes real coverage over the live constitution ──────
  it('PART A: real-registry coverage — real ratio, non-empty gaps, zero dangling on a clean checkout', () => {
    const report = computeCoverage({ registryPath: REAL_REGISTRY, projectDir: process.cwd() });

    // Real, non-empty output on day one — the actual constitution's standards.
    expect(report.summary.total).toBeGreaterThanOrEqual(15);

    // A genuine enforced ratio in a sane band (not the all-zero / all-one a broken
    // parser or extractor would yield).
    expect(report.summary.enforcedRatio).toBeGreaterThan(0.1);
    expect(report.summary.enforcedRatio).toBeLessThan(0.95);

    // The gap list is REAL and non-empty — there ARE standards still guarded only by
    // prose. That non-emptiness is the whole point: the audit surfaces them.
    expect(report.summary.gaps.length).toBeGreaterThan(0);

    // A clean checkout cites only real guards → zero dangling. (If this fails, the
    // registry references a guard file that no longer exists — fix the registry.)
    expect(report.summary.danglingCount).toBe(0);

    // A known-enforced standard classifies as ratchet (anchors the classifier).
    const nsd = report.standards.find((s) => s.standard.includes('No Silent Degradation'));
    expect(nsd?.enforcementKind).toBe('ratchet');
  });

  it('PART A: a planted dangling ref is surfaced as a broken guarantee', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'std-e2e-dangle-'));
    try {
      const regPath = path.join(tmp, 'docs', 'STANDARDS-REGISTRY.md');
      fs.mkdirSync(path.dirname(regPath), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true }); // so the auditor's src walk is valid
      fs.writeFileSync(regPath, [
        '## Building',
        '',
        '### Planted Dangling',
        '**Rule.** r.',
        '**Applied through.** Enforced by `tests/unit/guard-that-was-deleted.test.ts`.',
        '',
      ].join('\n'));
      const report = computeCoverage({ registryPath: regPath, projectDir: tmp });
      expect(report.summary.danglingCount).toBe(1);
      const s = report.standards.find((x) => x.standard === 'Planted Dangling');
      expect(s?.danglingRefs).toContain('tests/unit/guard-that-was-deleted.test.ts');
      expect(s?.enforcementKind).toBe('documented-only');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── PART B — the route is alive (200, not 503) through the server ─────────────
  let repo: string;
  let stateDir: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'std-e2e-route-'));
    stateDir = path.join(repo, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    // Mirror the live registry into the fixture so the route computes over real-shaped
    // content (the route resolves the registry from config.projectDir).
    const dst = path.join(repo, 'docs', 'STANDARDS-REGISTRY.md');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(REAL_REGISTRY, dst);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  function app(): express.Express {
    const a = express();
    a.use(express.json());
    a.use(authMiddleware(() => AUTH, 'test'));
    a.use('/', createRoutes({
    // Explicit test injection: PART C truncates this fixture on purpose.
    standardsRegistryResolutionOverride: resolveStandardsRegistryFromPath(path.join(repo, 'docs', 'STANDARDS-REGISTRY.md')),
      config: {
        projectName: 't', projectDir: repo, stateDir, port: 0, authToken: AUTH,
        sessions: {} as unknown, scheduler: {} as unknown,
        cartographer: { enabled: true, conformanceAudit: { enabled: true } },
      } as unknown as RouteContext['config'],
      cartographer: new CartographerTree({ projectDir: repo, stateDir }),
      startTime: new Date(),
    } as unknown as RouteContext));
    return a;
  }
  const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);

  /**
   * PART D WAS HERE, AND WAS REMOVED IN ROUND 10. Read this before adding it back.
   *
   * It drove the PRODUCTION resolver (no fixture override) and asserted a `registryCurrent`
   * verdict over the real packed constitution. The intent was right and the round-5
   * conformance finding that prompted it was right: the fixture path was the harness default,
   * so "the production path is covered" was an assumption nothing could falsify.
   *
   * WHY IT IS GONE. The e2e config deliberately builds no `dist` (a compiled `dist/cli.js`
   * wakes dormant tests that spawn `pnpm`, absent on the CI e2e runner), so this block needed
   * its own asset bootstrap. That bootstrap produced a DESIGN defect in each of four
   * consecutive review rounds:
   *
   *   r7  the asset call sat below a freshness return keyed on an unrelated artifact
   *   r8  the fix hoisted it above `tsc` — the generator imports from `dist`, so on CI
   *       (`npm ci`, no build) it exited 1 and aborted every unit+integration shard
   *   r9  the fix emitted ESM with no declared module type — aborting the whole e2e shard
   *       on Node 20.12–20.18, inside our own `engines` range
   *   r10 the setup file was untracked while the tracked config required it (e2e could not
   *       start at all); its emit-path assertion was bypassed by `tsc` exiting first; and
   *       the module-format fix had no guard, on a Node range CI never runs
   *
   * Four rounds, four defects, one component — whose only job was DUPLICATING coverage the
   * INTEGRATION tier already provides and which needs no bootstrap, because that config
   * builds `dist` anyway. `tests/integration/standards-coverage-route.test.ts` carries the
   * production-path block (added round 4, no override, asserts the same flags against the
   * same shipped derivation).
   *
   * This is a removal, not a softening: every round-10 finding against that machinery is
   * conceded in full. What is genuinely lost is e2e-TIER production coverage — the
   * integration tier proves the same wiring one layer down. If someone restores this, restore
   * the bootstrap WITH a Node-20.12 CI matrix entry and a guard that fails without the module
   * declaration, or the r8/r9/r10 defects come back with it.
   */

  it('PART B: GET /conformance/coverage/health is alive (200, not 503) when enabled', async () => {
    const res = await bearer(request(app()).get('/conformance/coverage/health')).set('X-Instar-Request', '1');
    expect(res.status).not.toBe(503); // wired, not gated off
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.converged).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(15);
    expect(typeof res.body.enforcedRatio).toBe('number');
  });

  it('PART C: the live route assesses the WHOLE constitution and states its denominator', () => {
    // honest-denominators instance 4 (2026-07-25): on the running server this route
    // reported enforcedRatio 0.0455 over `total: 22` while the registry on disk
    // carried 81 articles — a fragment posing as the whole, with nothing beside the
    // number to reveal it. The fixture here mirrors the REAL registry, so the
    // denominator the route reports must match the whole document.
    const parsed = parseStandardsRegistryDetailed(fs.readFileSync(REAL_REGISTRY, 'utf-8'));
    const report = computeCoverage({ registryPath: path.join(repo, 'docs/STANDARDS-REGISTRY.md'), projectDir: repo });

    expect(report.summary.total).toBe(parsed.articles.length);
    expect(report.summary.registry.articleHeadings).toBe(parsed.diagnostics.articleHeadings);
    expect(report.summary.registry.droppedHeadings).toEqual([]);
    expect(report.summary.registry.enforcementScope.recognizedHeadings).toContain(
      'Enforced by (structure, not willpower)',
    );
    expect(report.summary.registry.enforcementScope.excludedProvenanceHeadings).toContain('Earned from');
    expect(report.summary.registry.enforcementScope.excludedNarrativeHeadings).toContain(
      'Three postures, in increasing order of ambition',
    );
    expect(report.summary.registry.enforcementScope.capturedSections).toBeGreaterThan(0);
    expect(report.summary.registry.enforcementScope.unrecognizedSections).toEqual([]);
    // Every family in the document is assessed — including one no code names.
    expect(report.summary.registry.families).toEqual(parsed.diagnostics.families);
    expect(report.summary.registry.families).toContain('The Fractal');
  });

  it('PART A: alternate enforcement headings correct the four known false gaps', () => {
    const report = computeCoverage({ registryPath: REAL_REGISTRY, projectDir: process.cwd() });
    const byName = (name: string) => report.standards.find((standard) => standard.standard.startsWith(name));

    const framework = byName('Framework-Agnostic');
    expect(framework?.enforcementKind).toBe('ratchet');
    expect(framework?.danglingRefs).toEqual([]);
    expect(framework?.guards).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: 'src/core/frameworkSessionLaunch.ts', refResolves: true }),
      expect.objectContaining({ ref: 'src/core/frameworkInjectionProcesses.ts', refResolves: true }),
      expect.objectContaining({ ref: 'tests/unit/framework-agnosticism.test.ts', refResolves: true }),
    ]));

    expect(byName('Testing Integrity')?.enforcementKind).toBe('spec-only');
    expect(byName('No Manual Work')?.enforcementKind).toBe('spec-only');
    expect(byName('Signal vs. Authority')?.enforcementKind).toBe('spec-only');
    for (const name of ['Framework-Agnostic', 'Testing Integrity', 'No Manual Work', 'Signal vs. Authority']) {
      expect(report.summary.gaps.some((gap) => gap.startsWith(name))).toBe(false);
    }
  });

  it('PART C: a TRUNCATED registry cannot present itself as a trustworthy assessment', async () => {
    // The live shape of the defect: the audit read a stale, much shorter copy. Any
    // such fragment must come back flagged, with the denominator visible, rather
    // than as a confident low ratio.
    const full = fs.readFileSync(REAL_REGISTRY, 'utf-8');
    fs.writeFileSync(path.join(repo, 'docs/STANDARDS-REGISTRY.md'), full.split('\n').slice(0, 300).join('\n'));

    const res = await bearer(request(app()).get('/conformance/coverage/health')).set('X-Instar-Request', '1');
    expect(res.status).toBe(200);
    expect(res.body.assessmentTrustworthy).toBe(false);
    expect(res.body.assessmentConfidence).toBe('untrustworthy');
    expect(res.body.confidenceReason).toBeTruthy();
    expect(res.body.registry.canaryOk).toBe(false);
    expect(res.body.registry.canaryFailures.length).toBeGreaterThan(0);
    // The denominator is present so a reader can SEE it is a fragment.
    expect(res.body.registry.parsed).toBe(res.body.total);
    expect(res.body.convergedMeans).toMatch(/NOT that standards are healthy/i);
  });
});
