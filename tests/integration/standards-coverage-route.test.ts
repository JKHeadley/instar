// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup; no git used here.
/**
 * Tier 2 (integration) tests for the GET /conformance/coverage + /coverage/health
 * routes (cartographer-conformance-audit spec #3). Exercises the REAL Express routes
 * behind the REAL authMiddleware over a fixture repo + registry. Mirrors the spec #2
 * cartographer-refresh-route harness.
 *
 * Covers: the two gates (null cartographer → 503; conformanceAudit.enabled=false →
 * 503), the X-Instar-Request:1 intent gate (403 without it), auth (401 without a
 * bearer), the 200 shape, and the ?family / ?kind / ?status=gap filters.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { createRoutes, deriveCoverageClientFlags, type RouteContext } from '../../src/server/routes.js';
import { resolveStandardsRegistry, resolveStandardsRegistryFromPath } from '../../src/core/standardsRegistryPath.js';
import { computeCoverage as computeStandardsCoverage } from '../../src/core/StandardsEnforcementAuditor.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { CartographerTree } from '../../src/core/CartographerTree.js';

const AUTH = 'test-bearer-token';

let repo: string;
let stateDir: string;

function write(rel: string, content: string): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'std-route-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  // A fixture registry exercising a ratchet, a gate, and a gap so the filters bite.
  write('tests/unit/no-foo.test.ts', '// ratchet\n');
  write('src/core/G.ts', 'export const B16_UNVERIFIED_WALL = 1;\n');
  write('src/server/routes.ts', "router.get('/x', (req,res)=>{});\n");
  write('docs/STANDARDS-REGISTRY.md', [
    '## Building',
    '',
    '### Ratchet One',
    '**Rule.** r.',
    '**Applied through.** `tests/unit/no-foo.test.ts`.',
    '',
    '### Gate One',
    '**Rule.** r.',
    '**Applied through.** `B16_UNVERIFIED_WALL`.',
    '',
    '## Interaction',
    '',
    '### Gap One',
    '**Rule.** r.',
    '**In practice.** just remember it.',
    '',
  ].join('\n'));
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

function ctxWith(cartographer: CartographerTree | null, auditEnabled: boolean): RouteContext {
  return {
    // Explicit test injection: assert filters/shape against a CONTROLLED
    // constitution. Production resolves the packed asset and never sets this.
    standardsRegistryResolutionOverride: resolveStandardsRegistryFromPath(path.join(repo, 'docs', 'STANDARDS-REGISTRY.md')),
    config: {
      projectName: 't',
      projectDir: repo,
      stateDir,
      port: 0,
      authToken: AUTH,
      sessions: {} as unknown,
      scheduler: {} as unknown,
      cartographer: {
        enabled: true,
        conformanceAudit: { enabled: auditEnabled },
      },
    } as unknown as RouteContext['config'],
    cartographer,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(cartographer: CartographerTree | null, auditEnabled = true): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctxWith(cartographer, auditEnabled)));
  return app;
}

const tree = (): CartographerTree => new CartographerTree({ projectDir: repo, stateDir });
const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);
const intent = (r: request.Test) => r.set('X-Instar-Request', '1');

describe('GET /conformance/coverage (Tier 2 integration)', () => {
  it('401 without a bearer token', async () => {
    const res = await intent(request(appWith(tree())).get('/conformance/coverage'));
    expect(res.status).toBe(401);
  });

  it('503 when the cartographer is disabled (null tree)', async () => {
    const res = await intent(bearer(request(appWith(null)).get('/conformance/coverage')));
    expect(res.status).toBe(503);
  });

  it('503 when conformanceAudit is disabled (cartographer on, audit off)', async () => {
    const res = await intent(bearer(request(appWith(tree(), false)).get('/conformance/coverage')));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/conformance audit not enabled/i);
  });

  it('403 without the X-Instar-Request:1 intent header', async () => {
    const res = await bearer(request(appWith(tree())).get('/conformance/coverage'));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/X-Instar-Request/i);
  });

  it('200 + documented shape when enabled, authed, with the intent header', async () => {
    const res = await intent(bearer(request(appWith(tree())).get('/conformance/coverage')));
    expect(res.status).toBe(200);
    expect(res.body.summary).toBeDefined();
    expect(typeof res.body.summary.enforcedRatio).toBe('number');
    expect(Array.isArray(res.body.standards)).toBe(true);
    expect(res.body.count).toBe(3);
    const kinds = res.body.standards.map((s: { enforcementKind: string }) => s.enforcementKind);
    expect(kinds).toContain('ratchet');
    expect(kinds).toContain('gate');
    expect(kinds).toContain('documented-only');
  });

  /**
   * The top-level `usable` flag lived on `/health` only. That put the guarantee
   * ("a client that inspects nothing else still sees the state") on the SECONDARY
   * route while the PRIMARY one — the route a client actually reads standards
   * from — buried usability two levels down in `summary.assessmentConfidence`.
   */
  it('carries a TOP-LEVEL usable flag, same contract as /health', async () => {
    const res = await intent(bearer(request(appWith(tree())).get('/conformance/coverage')));
    expect(res.status).toBe(200);
    expect(typeof res.body.usable).toBe('boolean');
    // It must agree with the detail it summarises, in both directions.
    expect(res.body.usable).toBe(res.body.summary.assessmentConfidence !== 'untrustworthy');

    const health = await intent(bearer(request(appWith(tree())).get('/conformance/coverage/health')));
    expect(health.body.usable).toBe(res.body.usable);
  });

  /**
   * A fixture registry reaches the route through a caller-supplied path, so the
   * audit must NOT report `verified` over it — and the reason must say why in
   * plain words rather than leaving the client to infer it from an absence.
   */
  it('a caller-supplied fixture registry is never reported as verified', async () => {
    const res = await intent(bearer(request(appWith(tree())).get('/conformance/coverage')));
    // A 3-article fixture also trips the registry canary, so the verdict here is
    // 'untrustworthy' — an EARLIER branch than the basis check. The assertion is
    // therefore the invariant that holds regardless of which branch answered:
    // a fixture can never be reported verified, and the reason is always stated.
    expect(res.body.summary.assessmentConfidence).not.toBe('verified');
    expect(res.body.summary.assessmentTrustworthy).toBe(false);
    expect(res.body.summary.confidenceReason).toBeTruthy();
  });

  it('?status=gap filters to documented-only standards', async () => {
    const res = await intent(bearer(request(appWith(tree())).get('/conformance/coverage?status=gap')));
    expect(res.status).toBe(200);
    expect(res.body.standards.every((s: { enforcementKind: string }) => s.enforcementKind === 'documented-only')).toBe(true);
    expect(res.body.standards.map((s: { standard: string }) => s.standard)).toContain('Gap One');
  });

  it('?kind=ratchet filters to ratchet standards', async () => {
    const res = await intent(bearer(request(appWith(tree())).get('/conformance/coverage?kind=ratchet')));
    expect(res.status).toBe(200);
    expect(res.body.standards.length).toBe(1);
    expect(res.body.standards[0].standard).toBe('Ratchet One');
  });

  it('?family=Interaction filters to that family', async () => {
    const res = await intent(bearer(request(appWith(tree())).get('/conformance/coverage?family=Interaction')));
    expect(res.status).toBe(200);
    expect(res.body.standards.every((s: { family: string }) => s.family === 'Interaction')).toBe(true);
    expect(res.body.standards.map((s: { standard: string }) => s.standard)).toEqual(['Gap One']);
  });
});

describe('GET /conformance/coverage/health (Tier 2 integration)', () => {
  it('401 without a bearer token', async () => {
    const res = await intent(request(appWith(tree())).get('/conformance/coverage/health'));
    expect(res.status).toBe(401);
  });

  it('503 when conformanceAudit is disabled', async () => {
    const res = await intent(bearer(request(appWith(tree(), false)).get('/conformance/coverage/health')));
    expect(res.status).toBe(503);
  });

  it('403 without the intent header', async () => {
    const res = await bearer(request(appWith(tree())).get('/conformance/coverage/health'));
    expect(res.status).toBe(403);
  });

  it('200 summary shape when enabled', async () => {
    const res = await intent(bearer(request(appWith(tree())).get('/conformance/coverage/health')));
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.converged).toBe(true);
    expect(res.body.total).toBe(3);
    expect(res.body.byKind).toBeDefined();
    expect(typeof res.body.enforcedRatio).toBe('number');
    expect(Array.isArray(res.body.gaps)).toBe(true);
    expect(res.body.gaps).toContain('Gap One');
    expect(res.body.danglingCount).toBe(0);
  });
});

/**
 * THE PRODUCTION PATH, exercised as `AgentServer` wires it — no override.
 *
 * Review's round-3 finding, and it is round 1's finding one layer up: every Tier-2 and
 * Tier-3 case injects `resolveStandardsRegistryFromPath(...)`, which resolves
 * `caller-supplied-path` and can never reach `verified`. So the real wiring
 * (`registryResolution: resolveStandardsRegistry()`) was exercised by NOTHING, and the
 * `packed-meta-match → verified` path had no coverage above the unit tier at all.
 *
 * That is the same shape as the defect this whole change removes: the thing everyone
 * assumed was covered was covered only by an input that could not contradict it.
 */
describe('GET /conformance/coverage — the PRODUCTION resolution path (no override)', () => {
  const REPO_ROOT = path.resolve(__dirname, '../..');

  function prodApp(): express.Express {
    // Built WITHOUT the shared `ctxWith` helper, deliberately.
    //
    // That helper sets `standardsRegistryResolutionOverride` to a fixture — which is the
    // very thing this block exists to avoid, and it is so baked into the harness that the
    // first draft of THIS test inherited it and reported `untrustworthy` over a
    // three-article fixture. That is a sharper demonstration of the finding than the
    // finding was: the fixture path is the default by construction, so "the production
    // path is covered" was an assumption nothing could have falsified.
    const ctx = {
      config: {
        projectName: 't',
        projectDir: REPO_ROOT,
        stateDir,
        port: 0,
        authToken: AUTH,
        sessions: {} as unknown,
        scheduler: {} as unknown,
        cartographer: { enabled: true, conformanceAudit: { enabled: true } },
      },
      cartographer: new CartographerTree({ projectDir: REPO_ROOT, stateDir }),
      startTime: new Date(),
      // NO standardsRegistryResolutionOverride — the route calls the real resolver.
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use(authMiddleware(() => AUTH, 'test'));
    app.use('/', createRoutes(ctx));
    return app;
  }

  it('reports verified over the REAL packed constitution, not a fixture', async () => {
    const res = await intent(bearer(request(prodApp()).get('/conformance/coverage')));
    expect(res.status).toBe(200);
    expect(res.body.summary.assessmentConfidence).toBe('verified');
    expect(res.body.registryCurrent).toBe(true);
    expect(res.body.usable).toBe(true);
    expect(res.body.guardsAnalyzable).toBe(true);
    expect(res.body.summary.guards.freshnessVerified).toBe(true);
    expect(res.body.summary.guards.sourceIndexSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.summary.guards.projectDir).toBe(fs.realpathSync(REPO_ROOT));
    expect(res.body.summary.guards.configuredProjectDir).toBe(REPO_ROOT);
    // Graded over the WHOLE constitution — the point of the change.
    expect(res.body.summary.total).toBeGreaterThanOrEqual(60);
    // And the fleet key the spec names as its rollout discriminator is actually present.
    expect(res.body.summary.registry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the reason states the basis AND its limits, so a client cannot over-read `verified`', async () => {
    const res = await intent(bearer(request(prodApp()).get('/conformance/coverage')));
    const reason = res.body.summary.confidenceReason as string;
    expect(reason).toMatch(/currency/i);
    expect(reason).toMatch(/not a runtime check/i);
    expect(reason).toMatch(/not tamper-resistant/i);
  });

  /**
   * The truth table in §0 is only worth publishing if the illegal states are actually
   * unreachable. Asserted rather than asserted-in-prose.
   */
  /**
   * TABLE-DRIVEN over all four legal states — because the first version of this test
   * COULD NOT FAIL, and round 6 caught that.
   *
   * It ran one input (the real repo, always `registryCurrent: true`), so
   * `if (registryCurrent) expect(usable).toBe(true)` merely restated what
   * `deriveAssessmentConfidence` guarantees by construction: `'verified'` is unreachable
   * unless the canary passed, total > 0 and the guard tree is analyzable. The
   * `if (!registryUsable || !guardsAnalyzable)` branch never executed at all, and
   * `verifiedKind === null` was asserted nowhere. A truth table pinned by a test that
   * only ever sees one row is a table nobody is checking — the fourth cannot-fire guard
   * this change has produced, and the second I wrote while documenting the pattern.
   */
  it('every legal state derives its flags correctly, and the null branch is exercised', () => {
    const REAL = path.resolve(__dirname, '../..');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-instar-'));
    try {
      /**
       * `expected` is the LITERAL row §0 publishes for this input — hardcoded, never
       * derived. That is the difference between this attempt and the previous three.
       *
       * Attempt 1 ran one input, so a branch never executed. Attempt 2 recomputed the
       * route's formulas here, making the assertion `x === x`. Attempt 3 (below) imports
       * the shipped `deriveCoverageClientFlags`, which proves the two ROUTES cannot
       * disagree — but NOT that the function implements the published table, because the
       * expectations were still phrased in terms of its own output
       * (`registryCurrent ? KIND : null` passes whichever value `registryCurrent` holds).
       *
       * A table is only checked by values written down independently of the code that
       * produces them. If the derivation regresses, these literals fail.
       */
      const cases: Array<{
        name: string; projectDir: string; useFixture: boolean;
        expected: {
          usable: boolean; registryUsable: boolean; guardsAnalyzable: boolean;
          registryCurrent: boolean; verifiedKind: string | null; coverageState: string;
        };
      }> = [
        {
          name: 'current (production path)', projectDir: REAL, useFixture: false,
          expected: {
            usable: true, registryUsable: true, guardsAnalyzable: true,
            registryCurrent: true, verifiedKind: 'packed-asset-current-with-build',
            coverageState: 'package-stamped',
          },
        },
        {
          name: 'fixture basis → unverified', projectDir: REAL, useFixture: true,
          expected: {
            usable: true, registryUsable: true, guardsAnalyzable: true,
            registryCurrent: false, verifiedKind: null,
            coverageState: 'usable-unverified',
          },
        },
        {
          // Caller-supplied registry deliberately bypasses the production packed-index
          // fallback so this row still exercises the genuinely missing-guards state.
          name: 'unanalyzable guard tree', projectDir: empty, useFixture: true,
          expected: {
            usable: false, registryUsable: true, guardsAnalyzable: false,
            registryCurrent: false, verifiedKind: null,
            coverageState: 'missing-guards',
          },
        },
      ];
      const seen = new Set<string>();
      for (const c of cases) {
        const res = resolveStandardsRegistry();
        if (!res.usable) throw new Error('resolver unusable');
        const resolution = c.useFixture
          ? resolveStandardsRegistryFromPath(res.path)
          : res;
        const report = computeStandardsCoverage({
          registryPath: resolution.usable ? resolution.path : res.path,
          projectDir: c.projectDir,
          registryMarkdown: resolution.usable ? resolution.markdown : res.markdown,
          integrity: resolution.usable ? resolution.integrity : undefined,
        });
        const conf = report.summary.assessmentConfidence;
        seen.add(conf);

        // The flags come from the SHIPPED derivation, not a copy of its formulas.
        //
        // Round 7 caught the previous version recomputing `registryCurrent`/`usable`/
        // `verifiedKind` here from routes.ts's own expressions, which made
        // `expect(verifiedKind).toBe(registryCurrent ? K : null)` literally `x === x` and
        // left a regression in the route's derivation — the only thing the truth table is
        // about — invisible. Two attempts at this test each produced a new cannot-fire
        // guard; importing the one function both routes call is what ends that.
        const { usable, registryCurrent, guardsAnalyzable, verifiedKind } =
          deriveCoverageClientFlags(report.summary);

        // The invariant, asserted on EVERY row rather than the one row that satisfies it.
        if (registryCurrent) {
          expect(usable, `${c.name}: verified without usable`).toBe(true);
          expect(guardsAnalyzable, `${c.name}: verified without an analyzable tree`).toBe(true);
        }
        if (!guardsAnalyzable) {
          expect(registryCurrent, `${c.name}: no guard tree must not be current`).toBe(false);
          expect(verifiedKind, `${c.name}: null branch`).toBeNull();
        }
        // THE ROW, asserted against literals written down independently of the code.
        // Every field, so a regression in any one of them fails here rather than
        // surviving because a sibling field moved with it.
        const { coverageState } = deriveCoverageClientFlags(report.summary);
        expect(
          { usable, registryUsable: report.summary.registryUsable ?? true,
            guardsAnalyzable, registryCurrent, verifiedKind, coverageState },
          `${c.name}: derived row does not match the row §0 publishes for this input`,
        ).toEqual(c.expected);
      }
      // The table is only meaningful if the rows actually DIFFER.
      expect(seen.size, `all cases produced the same verdict (${[...seen]}) — table is vacuous`)
        .toBeGreaterThan(1);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('/health agrees with /coverage on every top-level flag', async () => {
    const cov = await intent(bearer(request(prodApp()).get('/conformance/coverage')));
    const health = await intent(bearer(request(prodApp()).get('/conformance/coverage/health')));

    // PRESENCE FIRST. Since both routes spread one shared function, this loop's equality
    // check is satisfied by `undefined === undefined` — so a flag DROPPED from that
    // function would pass it silently. That is not hypothetical for `verifiedKind`: when
    // the truth-table test moved off the route, this became its only HTTP-level mention,
    // and an equality-only check would have been no cover at all.
    for (const flag of ['usable', 'registryCurrent', 'registryUsable', 'guardsAnalyzable', 'verifiedKind']) {
      expect(Object.hasOwn(cov.body, flag), `/coverage is missing "${flag}" entirely`).toBe(true);
      expect(Object.hasOwn(health.body, flag), `/health is missing "${flag}" entirely`).toBe(true);
      expect(health.body[flag], `flag ${flag} disagrees between the two routes`).toBe(cov.body[flag]);
    }

    // And `verifiedKind` pinned to its literal contract over the real HTTP body, not just
    // route-to-route agreement — two routes can agree on the same wrong value.
    expect(cov.body.verifiedKind, 'verifiedKind must track registryCurrent in the payload')
      .toBe(cov.body.registryCurrent ? 'packed-asset-current-with-build' : null);
  });
});
