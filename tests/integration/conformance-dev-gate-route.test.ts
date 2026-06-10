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
