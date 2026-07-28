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
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
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
