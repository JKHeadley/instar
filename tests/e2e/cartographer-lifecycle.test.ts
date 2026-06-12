// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 3 (E2E "feature is alive") test for the Cartographer doc-tree
 * (cartographer-doc-tree-schema spec #1).
 *
 * The single most important test: it proves the feature is genuinely alive
 * end-to-end — the routes are wired to a REAL CartographerTree (not a null/no-op),
 * /cartographer/health returns 200 (not 503) with a real nodeCount, and the
 * author → fresh → mutate-code → stale lifecycle works through the route layer,
 * backed by real git. A no-op or mis-wired feature fails this immediately.
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
let carto: CartographerTree;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-e2e-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  carto = new CartographerTree({ projectDir: repo, stateDir });
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(() => AUTH, 'test'));
  a.use('/', createRoutes({
    config: { projectName: 't', projectDir: repo, stateDir, port: 0, authToken: AUTH, sessions: {} as any, scheduler: {} as any } as any,
    cartographer: carto,
    startTime: new Date(),
  } as unknown as RouteContext));
  return a;
}
const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);

// fix instar#1069: /health + /stale serve the per-host SNAPSHOT (written by the
// sweep's detect), never a lazy scaffold. This helper runs the SAME bounded detect
// the engine runs and persists the snapshot the routes read — so this E2E exercises
// the real snapshot-backed contract end-to-end.
function refreshSnapshot(): void {
  const r = runDetect({
    indexPath: carto.indexFilePath(), projectDir: repo, maxIndexBytes: 256 * 1024 * 1024,
    maxCandidates: 100, maxNodesPerPass: 25, maxDeferredPasses: 5, revalidateSamplePerPass: 0,
    graceMs: 0, gitMaxBuffer: 64 * 1024 * 1024, snapshotSampleMax: 500, nowMs: Date.now(),
  });
  writeSnapshot(carto.snapshotPath(), {
    generatedAt: new Date().toISOString(), headSha: r.counts.headSha, counts: r.counts,
    freshness: r.freshness, staleSample: r.staleSample, staleTotal: r.staleTotal,
    staleSampleTruncated: r.staleSample.length < r.staleTotal,
    lastDetectStatus: 'ok', lastDetectAt: new Date().toISOString(), durationMs: r.durationMs,
  });
}

describe('Cartographer doc-tree — feature is alive (Tier 3 E2E)', () => {
  it('health route is wired and returns 200 with a real nodeCount from the snapshot (not 503)', async () => {
    carto.scaffold();
    refreshSnapshot();
    const res = await bearer(request(app()).get('/cartographer/health'));
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.snapshot).toBe('present');
    expect(res.body.nodeCount).toBeGreaterThanOrEqual(1);
  });

  it('full lifecycle: author → fresh → mutate code → stale, observed through /cartographer/stale', async () => {
    const a = app();
    carto.scaffold();
    carto.setSummary('src/index.ts', 'entry point exporting `a`');
    refreshSnapshot();

    // freshly authored → not in the stale snapshot sample as 'stale'
    let res = await bearer(request(a).get('/cartographer/stale'));
    expect(res.status).toBe(200);
    expect(res.body.nodes.filter((n: { status: string }) => n.status === 'stale')).toHaveLength(0);

    // the node reads back with its summary (single-node read — always live)
    res = await bearer(request(a).get('/cartographer/node?path=src/index.ts'));
    expect(res.body.summary).toBe('entry point exporting `a`');

    // mutate the covered code + commit → its git oid changes
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 2;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'change index']);

    // re-run detect (the sweep's job) → the snapshot now reflects the stale node.
    refreshSnapshot();
    res = await bearer(request(a).get('/cartographer/stale'));
    const stalePaths = res.body.nodes
      .filter((n: { status: string }) => n.status === 'stale')
      .map((n: { path: string }) => n.path);
    expect(stalePaths).toContain('src/index.ts');
  });
});
