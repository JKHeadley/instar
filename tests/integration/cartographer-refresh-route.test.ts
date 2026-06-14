// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 2 (integration) tests for the POST /cartographer/node/refresh route
 * (cartographer-doc-freshness spec #2 — the Tier-1 inline write surface). Exercises
 * the REAL CartographerTree behind the REAL Express route with the REAL
 * authMiddleware. Mirrors the spec #1 harness (cartographer-routes.test.ts): a real
 * git fixture repo, a Bearer-gated app, and the cartographer enabled over the repo.
 *
 * Covers the two gates (null tree → 503; freshnessSweep.enabled=false → 503), the
 * full path-validation matrix (400), the deterministic quality bar (symbol-less 400),
 * the happy path (200 + provenance.source === 'inline-agent' read back), and auth (401).
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
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-refresh-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  // A committed .ts leaf with a DISTINCTIVE declared symbol. extractCodeSymbols
  // picks up `uniqueSampleSymbol`, so the deterministic quality bar is non-vacuous:
  // a summary that names it passes (200); one that doesn't fails (400).
  fs.writeFileSync(
    path.join(repo, 'src', 'Sample.ts'),
    'export function uniqueSampleSymbol() {\n  return 0;\n}\n',
  );
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

// Config mirrors spec #1's ctxWith, but ALSO nests cartographer.freshnessSweep so
// the second gate (POST refresh) is open. minSummaryChars kept small so realistic
// short summaries clear the floor.
function ctxWith(cartographer: CartographerTree | null, sweepEnabled: boolean): RouteContext {
  return {
    config: {
      projectName: 't',
      projectDir: repo,
      stateDir,
      port: 0,
      authToken: AUTH,
      sessions: {} as any,
      scheduler: {} as any,
      cartographer: {
        enabled: true,
        freshnessSweep: { enabled: sweepEnabled, minSummaryChars: 10, maxSummaryChars: 600, maxLeafBytes: 24576 },
      },
    } as any,
    cartographer,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(cartographer: CartographerTree | null, sweepEnabled = true): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctxWith(cartographer, sweepEnabled)));
  return app;
}

const tree = (): CartographerTree => new CartographerTree({ projectDir: repo, stateDir });
// fix instar#1069: the refresh route no longer lazy-scaffolds — a node must already
// exist (the boot-path scaffold builds the index). Tests targeting a real node scaffold first.
const scaffoldedTree = (): CartographerTree => { const t = tree(); t.scaffold(); return t; };
const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);

describe('POST /cartographer/node/refresh (Tier 2 integration)', () => {
  it('401 without a bearer token', async () => {
    const res = await request(appWith(tree()))
      .post('/cartographer/node/refresh')
      .send({ path: 'src/Sample.ts', summary: 'Implements uniqueSampleSymbol for the sample.' });
    expect(res.status).toBe(401);
  });

  it('503 when the cartographer is disabled (null tree)', async () => {
    const res = await bearer(
      request(appWith(null)).post('/cartographer/node/refresh'),
    ).send({ path: 'src/Sample.ts', summary: 'Implements uniqueSampleSymbol for the sample.' });
    expect(res.status).toBe(503);
  });

  it('503 when freshnessSweep is disabled (cartographer enabled, sweep off)', async () => {
    const res = await bearer(
      request(appWith(tree(), false)).post('/cartographer/node/refresh'),
    ).send({ path: 'src/Sample.ts', summary: 'Implements uniqueSampleSymbol for the sample.' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/freshness sweep not enabled/i);
  });

  it('200 happy path → refreshed, and the node reads back with inline-agent provenance + fresh', async () => {
    const app = appWith(scaffoldedTree());
    const res = await bearer(
      request(app).post('/cartographer/node/refresh'),
    ).send({ path: 'src/Sample.ts', summary: 'Implements uniqueSampleSymbol for the sample.' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refreshed: true, path: 'src/Sample.ts', status: 'fresh' });

    // Read it back through GET /cartographer/node — provenance must be inline-agent.
    const read = await bearer(request(app).get('/cartographer/node?path=src/Sample.ts'));
    expect(read.status).toBe(200);
    expect(read.body.provenance?.source).toBe('inline-agent');
    expect(read.body.lastAuthoredBy).toBe('inline-agent');
  });

  it('400 for a non-existent (unscaffolded) node path', async () => {
    const res = await bearer(
      request(appWith(tree())).post('/cartographer/node/refresh'),
    ).send({ path: 'src/DoesNotExist.ts', summary: 'Implements uniqueSampleSymbol for the sample.' });
    expect(res.status).toBe(400);
  });

  it('400 for a `..` traversal path', async () => {
    const res = await bearer(
      request(appWith(tree())).post('/cartographer/node/refresh'),
    ).send({ path: '../../etc/passwd', summary: 'Implements uniqueSampleSymbol for the sample.' });
    expect(res.status).toBe(400);
  });

  it('400 for an encoded `%2e%2e` traversal path', async () => {
    const res = await bearer(
      request(appWith(tree())).post('/cartographer/node/refresh'),
    ).send({ path: '%2e%2e/secret', summary: 'Implements uniqueSampleSymbol for the sample.' });
    expect(res.status).toBe(400);
  });

  it('400 for a leading-slash (absolute) path', async () => {
    const res = await bearer(
      request(appWith(tree())).post('/cartographer/node/refresh'),
    ).send({ path: '/etc/passwd', summary: 'Implements uniqueSampleSymbol for the sample.' });
    expect(res.status).toBe(400);
  });

  it('400 for an over-length (>4096-char) summary', async () => {
    const res = await bearer(
      request(appWith(tree())).post('/cartographer/node/refresh'),
    ).send({ path: 'src/Sample.ts', summary: 'uniqueSampleSymbol '.repeat(300) }); // ~5700 chars
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid summary/i);
  });

  it('400 for a symbol-less summary against a node WITH a distinctive symbol', async () => {
    const res = await bearer(
      request(appWith(scaffoldedTree())).post('/cartographer/node/refresh'),
    ).send({ path: 'src/Sample.ts', summary: 'This module does some generic work here.' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no symbol present/i);
  });
});
