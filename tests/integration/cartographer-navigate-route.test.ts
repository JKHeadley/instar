// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 2 (integration) tests for GET /cartographer/navigate
 * (cartographer-subtree-nav spec #5). Exercises the REAL CartographerNavigator
 * behind the REAL Express route with the REAL authMiddleware: 401 without a bearer,
 * 503 when disabled (null), 200 + the manifest shape + relevantPaths when enabled,
 * 400 on a missing/over-long query and out-of-range numeric bounds. Real git fixture.
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
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-nav-rt-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'src', 'messaging'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'messaging', 'TelegramAdapter.ts'), 'export class TelegramAdapter {}\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function ctxWith(cartographer: CartographerTree | null): RouteContext {
  return {
    config: { projectName: 't', projectDir: repo, stateDir, port: 0, authToken: AUTH, sessions: {} as any, scheduler: {} as any } as any,
    cartographer,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(cartographer: CartographerTree | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctxWith(cartographer)));
  return app;
}

const tree = (): CartographerTree => new CartographerTree({ projectDir: repo, stateDir });
// fix instar#1069: navigate no longer lazy-scaffolds (returns an empty manifest when
// the index isn't built). Tests asserting real paths scaffold first.
const scaffoldedTree = (): CartographerTree => { const t = tree(); t.scaffold(); return t; };
const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);

describe('GET /cartographer/navigate (Tier 2 integration)', () => {
  it('401 without a bearer token', async () => {
    const res = await request(appWith(tree())).get('/cartographer/navigate?query=telegram');
    expect(res.status).toBe(401);
  });

  it('503 when the feature is disabled (cartographer null)', async () => {
    const res = await bearer(request(appWith(null)).get('/cartographer/navigate?query=telegram'));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  it('400 on a missing query', async () => {
    const res = await bearer(request(appWith(tree())).get('/cartographer/navigate'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query/i);
  });

  it('400 on a blank query', async () => {
    const res = await bearer(request(appWith(tree())).get('/cartographer/navigate?query=%20%20'));
    expect(res.status).toBe(400);
  });

  it('400 on an over-long query', async () => {
    const long = 'a'.repeat(3000);
    const res = await bearer(request(appWith(tree())).get(`/cartographer/navigate?query=${long}`));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
  });

  it('400 on out-of-range maxDepth', async () => {
    const res = await bearer(request(appWith(tree())).get('/cartographer/navigate?query=telegram&maxDepth=0'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maxDepth/i);
  });

  it('400 on out-of-range maxResults', async () => {
    const res = await bearer(request(appWith(tree())).get('/cartographer/navigate?query=telegram&maxResults=99999'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maxResults/i);
  });

  it('400 on non-numeric maxDepth', async () => {
    const res = await bearer(request(appWith(tree())).get('/cartographer/navigate?query=telegram&maxDepth=abc'));
    expect(res.status).toBe(400);
  });

  it('200 + manifest shape + relevantPaths (index built off-request)', async () => {
    const res = await bearer(request(appWith(scaffoldedTree())).get('/cartographer/navigate?query=TelegramAdapter+messaging'));
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('TelegramAdapter messaging');
    expect(Array.isArray(res.body.relevantPaths)).toBe(true);
    expect(Array.isArray(res.body.scored)).toBe(true);
    expect(typeof res.body.summaryCoverage).toBe('number');
    expect(typeof res.body.nodesVisited).toBe('number');
    expect(typeof res.body.truncated).toBe('boolean');
    // The telegram subsystem leaf is among the relevant paths.
    const flat = JSON.stringify(res.body.relevantPaths);
    expect(flat).toContain('src/messaging');
  });

  it('200 + maxResults bound honored + truncated reported', async () => {
    const res = await bearer(request(appWith(scaffoldedTree())).get('/cartographer/navigate?query=telegram+messaging+src+index&maxResults=1'));
    expect(res.status).toBe(200);
    expect(res.body.scored.length).toBeLessThanOrEqual(1);
  });
});
