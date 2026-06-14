// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 2 (integration) tests for the GET /cartographer/* routes
 * (cartographer-doc-tree-schema spec #1). Exercises the REAL CartographerTree
 * behind the REAL Express routes with the REAL authMiddleware: 401 without a
 * bearer, 503 when disabled (null), 200 + correct shapes when enabled, 400 on a
 * traversal path, 404 on an unknown node. Real git fixture — staleness is git-backed.
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
import { runDetect, writeSnapshot } from '../../src/core/cartographerDetect.js';

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
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-rt-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
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
const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);

/**
 * fix instar#1069: the read routes now serve the per-host SNAPSHOT (written by the
 * sweep), never a lazy scaffold. This helper scaffolds the index AND writes the
 * snapshot the same way the engine's persistSnapshot does (synchronous detect), so
 * the route tests exercise the real snapshot-backed contract.
 */
function scaffoldAndSnapshot(t: CartographerTree): void {
  t.scaffold();
  const r = runDetect({
    indexPath: t.indexFilePath(), projectDir: repo, maxIndexBytes: 256 * 1024 * 1024,
    maxCandidates: 100, maxNodesPerPass: 25, maxDeferredPasses: 5, revalidateSamplePerPass: 0,
    graceMs: 0, gitMaxBuffer: 64 * 1024 * 1024, snapshotSampleMax: 500, nowMs: Date.now(),
  });
  writeSnapshot(t.snapshotPath(), {
    generatedAt: new Date().toISOString(), headSha: r.counts.headSha, counts: r.counts,
    freshness: r.freshness, staleSample: r.staleSample, staleTotal: r.staleTotal,
    staleSampleTruncated: r.staleSample.length < r.staleTotal,
    lastDetectStatus: 'ok', lastDetectAt: new Date().toISOString(), durationMs: r.durationMs,
  });
}

describe('GET /cartographer/* (Tier 2 integration)', () => {
  it('401 without a bearer token', async () => {
    const res = await request(appWith(tree())).get('/cartographer/health');
    expect(res.status).toBe(401);
  });

  it('503 when the feature is disabled (cartographer null)', async () => {
    const res = await bearer(request(appWith(null)).get('/cartographer/health'));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  it('health (no snapshot yet) → 200, enabled, snapshot:absent — never a lazy scaffold', async () => {
    const res = await bearer(request(appWith(tree())).get('/cartographer/health'));
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.snapshot).toBe('absent');
    expect(res.body.nodeCount).toBe(0);
    // The index must NOT have been scaffolded by the request (no event-loop walk).
    expect(fs.existsSync(path.join(stateDir, 'cartographer', 'index.json'))).toBe(false);
  });

  it('health (snapshot present) → 200, nodeCount ≥ 1, snapshot:present, freshness block', async () => {
    const t = tree(); scaffoldAndSnapshot(t);
    const res = await bearer(request(appWith(t)).get('/cartographer/health'));
    expect(res.status).toBe(200);
    expect(res.body.snapshot).toBe('present');
    expect(res.body.nodeCount).toBeGreaterThanOrEqual(1);
    expect(res.body.authoredCount).toBe(0);
    expect(res.body.freshness).toBeDefined();
    expect(typeof res.body.snapshotStale).toBe('boolean');
  });

  it('stale (snapshot present) → 200 with bounded sample + total + truncated', async () => {
    const t = tree(); scaffoldAndSnapshot(t);
    const res = await bearer(request(appWith(t)).get('/cartographer/stale'));
    expect(res.status).toBe(200);
    expect(res.body.snapshot).toBe('present');
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.truncated).toBe('boolean');
  });

  it('stale (no snapshot) → 200, snapshot:absent, empty', async () => {
    const res = await bearer(request(appWith(tree())).get('/cartographer/stale'));
    expect(res.status).toBe(200);
    expect(res.body.snapshot).toBe('absent');
    expect(res.body.count).toBe(0);
    expect(res.body.nodes).toEqual([]);
  });

  it('tree?format=compact (snapshot present) → 200 with a nodeCount, no node map', async () => {
    const t = tree(); scaffoldAndSnapshot(t);
    const res = await bearer(request(appWith(t)).get('/cartographer/tree?format=compact'));
    expect(res.status).toBe(200);
    expect(res.body.nodeCount).toBeGreaterThanOrEqual(1);
    expect(res.body.nodes).toBeUndefined(); // compact omits the full node map
  });

  it('tree (full, small tree under ceiling) → 200 with the node map', async () => {
    const t = tree(); t.scaffold(); // full tree reads the on-disk index (byte-bounded)
    const res = await bearer(request(appWith(t)).get('/cartographer/tree'));
    expect(res.status).toBe(200);
    expect(res.body.nodes['src/index.ts']).toBeDefined();
  });

  it('tree (full, no index) → 200 indexState:not-built (never scaffolds on request)', async () => {
    const res = await bearer(request(appWith(tree())).get('/cartographer/tree'));
    expect(res.status).toBe(200);
    expect(res.body.indexState).toBe('not-built');
    expect(fs.existsSync(path.join(stateDir, 'cartographer', 'index.json'))).toBe(false);
  });

  it('node?path traversal attempt → 400', async () => {
    const t = tree(); t.scaffold();
    const res = await bearer(request(appWith(t)).get('/cartographer/node?path=../../etc/passwd'));
    expect(res.status).toBe(400);
  });

  it('node?path unknown → 404', async () => {
    const t = tree(); t.scaffold();
    const res = await bearer(request(appWith(t)).get('/cartographer/node?path=nope/missing.ts'));
    expect(res.status).toBe(404);
  });

  it('node?path known → 200 with the node', async () => {
    const t = tree(); t.scaffold();
    const res = await bearer(request(appWith(t)).get('/cartographer/node?path=src/index.ts'));
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('src/index.ts');
    expect(res.body.kind).toBe('file');
  });
});
