// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 2 (integration) for the DEV-AGENT-DARK-GATE-ENFORCEMENT route-gate fix
 * (Slice A2). The conformance-coverage gate now resolves via resolveDevAgentGate
 * instead of a strict `cfg?.enabled !== true`, so:
 *   - developmentAgent: true  + conformanceAudit.enabled OMITTED → LIVE (200)
 *   - fleet config (developmentAgent unset/false), enabled OMITTED → 503
 *   - explicit enabled: false force-darks even a dev agent → 503
 * Exercised through the REAL CartographerTree + REAL Express routes + REAL auth.
 * This catches the live failure mode the strict `!== true` would have produced
 * (undefined !== true → 503 on a dev agent despite the registry being green).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { resolveStandardsRegistryFromPath } from '../../src/core/standardsRegistryPath.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { CartographerTree } from '../../src/core/CartographerTree.js';

const AUTH = 'test-bearer-token';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd, stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

let repo: string;
let stateDir: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-devgate-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  // Minimal docs/STANDARDS-REGISTRY.md so the coverage compute has something to read.
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'STANDARDS-REGISTRY.md'), '# Standards Registry\n\nNo standards yet.\n');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function ctxWith(cfgExtra: Record<string, unknown>): RouteContext {
  return {
    // Explicit test injection: assert semantic boundaries against a CONTROLLED
    // constitution. Production resolves the packed asset and never sets this.
    standardsRegistryResolutionOverride: resolveStandardsRegistryFromPath(path.join(repo, 'docs', 'STANDARDS-REGISTRY.md')),
    config: {
      projectName: 't', projectDir: repo, stateDir, port: 0, authToken: AUTH,
      sessions: {} as any, scheduler: {} as any,
      ...cfgExtra,
    } as any,
    cartographer: new CartographerTree({ projectDir: repo, stateDir }),
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(cfgExtra: Record<string, unknown>): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctxWith(cfgExtra)));
  return app;
}

const get = (app: express.Express) =>
  request(app).get('/conformance/coverage')
    .set('Authorization', `Bearer ${AUTH}`)
    .set('X-Instar-Request', '1');

describe('GET /conformance/coverage — dev-agent dark-gate (Tier 2 integration)', () => {
  it('developmentAgent:true + conformanceAudit.enabled OMITTED → LIVE (200)', async () => {
    // No cartographer.conformanceAudit.enabled set → the gate must resolve via
    // developmentAgent. This is the exact case the old strict `!== true` broke.
    const res = await get(appWith({ developmentAgent: true, cartographer: { conformanceAudit: {} } }));
    expect(res.status).toBe(200);
    expect(res.body.standards).toBeDefined();
  });

  it('fleet config (developmentAgent unset) + enabled OMITTED → 503', async () => {
    const res = await get(appWith({ cartographer: { conformanceAudit: {} } }));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  it('developmentAgent:false + enabled OMITTED → 503', async () => {
    const res = await get(appWith({ developmentAgent: false, cartographer: { conformanceAudit: {} } }));
    expect(res.status).toBe(503);
  });

  it('explicit enabled:false force-darks even a dev agent → 503', async () => {
    const res = await get(appWith({ developmentAgent: true, cartographer: { conformanceAudit: { enabled: false } } }));
    expect(res.status).toBe(503);
  });

  it('explicit enabled:true is the fleet-flip → 200 even without developmentAgent', async () => {
    const res = await get(appWith({ cartographer: { conformanceAudit: { enabled: true } } }));
    expect(res.status).toBe(200);
  });

  it('missing the X-Instar-Request intent header → 403 (even on a dev agent)', async () => {
    const res = await request(appWith({ developmentAgent: true, cartographer: { conformanceAudit: {} } }))
      .get('/conformance/coverage')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /conformance/coverage/health — honest denominators (Tier 2 integration)', () => {
  const health = (app: express.Express) =>
    request(app).get('/conformance/coverage/health')
      .set('Authorization', `Bearer ${AUTH}`)
      .set('X-Instar-Request', '1');

  const devApp = () => appWith({ developmentAgent: true, cartographer: { conformanceAudit: {} } });

  it('reports enforcedRatio: null (not 0) over a registry that contributed no standards', async () => {
    // The fixture registry has no articles. Before honest-denominators this route
    // answered `enforcedRatio: 0` — read on a dashboard as "0% of our standards are
    // enforced", a measurement that had never been taken. Nothing measured → null.
    const res = await health(devApp());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.enforcedRatio).toBeNull();
    expect(res.body.assessmentTrustworthy).toBe(false);
    expect(res.body.assessmentConfidence).toBe('untrustworthy');
  });

  it('carries the registry provenance the ratio was computed over', async () => {
    const res = await health(devApp());
    expect(res.status).toBe(200);
    expect(res.body.registry).toBeDefined();
    expect(res.body.registry.path).toBe(path.join(repo, 'docs', 'STANDARDS-REGISTRY.md'));
    expect(res.body.registry.articleHeadings).toBe(0);
    expect(res.body.registry.parsed).toBe(0);
    expect(res.body.registry.bytes).toBeGreaterThan(0);
    expect(Array.isArray(res.body.registry.canaryFailures)).toBe(true);
  });

  it('never presents `converged` bare — the field carries what it actually means', async () => {
    // `converged: true` sitting alone beside enforcedRatio was read as "standards are
    // healthy" twice in one day (2026-07-25). It only ever meant "the pass is stable".
    const res = await health(devApp());
    expect(res.body.converged).toBe(true);
    expect(res.body.convergedMeans).toMatch(/deterministic pass is stable/i);
    expect(res.body.convergedMeans).toMatch(/NOT that standards are healthy/i);
  });

  it('a real (non-empty) registry yields a real ratio, marked trustworthy, over a visible denominator', async () => {
    // Same route, populated registry → the ratio IS computed, and its denominator +
    // trustworthiness travel with it so a fragment can never pose as the whole.
    let md = '## Building — engineering discipline\n\n';
    for (let i = 0; i < 20; i++) {
      md += `### Standard ${i}\n**Rule.** r${i}.\n**Applied through.** src/index.ts\n\n`;
    }
    fs.writeFileSync(path.join(repo, 'docs', 'STANDARDS-REGISTRY.md'), md);

    const res = await health(devApp());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(20);
    expect(res.body.registry.articleHeadings).toBe(20);
    expect(res.body.registry.parsed).toBe(20);
    expect(res.body.registry.droppedHeadings).toEqual([]);
    expect(res.body.registry.families).toEqual(['Building']);
    expect(typeof res.body.enforcedRatio).toBe('number');
  });
});
