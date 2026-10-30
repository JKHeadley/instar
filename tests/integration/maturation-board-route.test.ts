import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMaturationBoardRoutes, resolveReviewsDir } from '../../src/server/maturationBoardRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const rm = (p: string) => SafeFsExecutor.safeRmSync(p, { recursive: true, force: true, operation: 'tests/integration/maturation-board-route.test.ts:cleanup' });

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function review(date: string, features: Array<Record<string, unknown>>) {
  return JSON.stringify({ schema: 'maturation-review/1', date, features });
}

interface Fixture { root: string; projectDir: string; stateDir: string; reviewsDir: string }

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mb-'));
  const projectDir = path.join(root, 'agent');
  const stateDir = path.join(projectDir, '.instar');
  const reviewsDir = path.join(projectDir, 'docs/research/feature-maturation/reviews');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(reviewsDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  return { root, projectDir, stateDir, reviewsDir };
}

function ctxFor(fx: Fixture, over: Record<string, unknown> = {}) {
  return {
    config: { stateDir: fx.stateDir, authToken: 'tok', developmentAgent: true, ...(over.config as object ?? {}) },
    meshSelfId: 'm_self',
    machinePoolRegistry: { getCapacity: (id: string) => ({ nickname: id === 'm_self' ? 'Self' : id === 'm_peer' ? 'Peer' : id }) },
    resolvePeerUrls: () => [],
    recordRopeResult: null,
    commitmentTracker: { getAll: () => [
      { id: 'CMT-1', status: 'pending', createdAt: '2026-10-01T00:00:00Z', checkInAt: '2026-10-05T00:00:00Z', nextUpdateDueAt: '2026-09-01T00:00:00Z' },
    ] },
    initiativeTracker: { list: () => [
      { id: 'feat-a', title: 'Feature A', status: 'active', updatedAt: '2026-10-20T00:00:00Z', rollout: { flagPath: 'feat.a.enabled', stage: 'dark' } },
      { id: 'bookkeeping', title: 'Standards delta', status: 'active', rollout: { lastDigestNotifiedAt: '2026-10-29T00:00:00Z' } },
    ] },
    blockerLifecycleService: { localSummary: () => ({ maturation: { features: [{ featureId: 'feat-a', status: 'ready', rung: 'dev-agent-live', passingMetrics: 1, totalMetrics: 1, evaluatedAt: '2026-10-30T00:00:00Z' }], accounting: [] } }) },
    guardRegistry: null,
    darkFlagRegistry: null,
    ...over,
  } as never;
}

function appFor(ctx: never) {
  return express().use(createMaturationBoardRoutes(ctx));
}

describe('GET /maturation/board', () => {
  let fx: Fixture;
  const servers: http.Server[] = [];
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    rm(fx.root);
  });

  it('answers 503 when the gate is off', async () => {
    const res = await request(appFor(ctxFor(fx, { config: { developmentAgent: false } }))).get('/maturation/board');
    expect(res.status).toBe(503);
  });

  it('builds a local board from review files and live owners', async () => {
    fs.writeFileSync(path.join(fx.reviewsDir, `${daysAgo(2)}.json`), review(daysAgo(2), [
      { id: 'feat.a', verdict: 'blind', evidence: 'x', evidenceReadToday: true, commitments: [] },
    ]));
    fs.writeFileSync(path.join(fx.reviewsDir, `${today()}.json`), review(today(), [
      { id: 'feat.a', title: 'Feature A', verdict: 'stalled', evidence: 'no runs', evidenceReadToday: true, commitments: ['CMT-1'] },
      { id: 'feat.b', verdict: 'live', evidence: 'healthy', evidenceReadToday: true, commitments: [] },
    ]));
    const res = await request(appFor(ctxFor(fx))).get('/maturation/board');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schema: 'maturation-board/1', advisory: true, authority: 'none', reviewDate: today(), reviewState: 'ok' });
    const a = res.body.features.find((f: { id: string }) => f.id === 'feat.a');
    expect(a.review.verdict).toBe('stalled');
    expect(a.history.map((h: { verdict: string }) => h.verdict)).toEqual(['blind', 'stalled']);
    // checkInAt is the deadline; the nudge marker is not.
    expect(a.deadlines).toHaveLength(1);
    expect(a.deadlines[0]).toMatchObject({ source: 'commitment', ref: 'CMT-1', open: true });
    expect(a.followUp.state).toBe('linked');
    // rollout + D7 owners attach through the flagPath alias; bookkeeping-only rollouts never appear.
    expect(a.owners.map((o: { source: string }) => o.source).sort()).toEqual(['d7', 'rollout']);
    expect(res.body.features.some((f: { id: string }) => f.id === 'bookkeeping')).toBe(false);
    // D7 ready vs review stalled is not in the closed conflict table.
    expect(a.conflicts).toEqual([]);
    // Sources the board could not read are reported, not hidden.
    expect(res.body.sources.find((s: { name: string }) => s.name === 'dark-flag')).toMatchObject({ ok: false, reason: 'registry-not-running' });
  });

  it('reports a rejected newer review instead of silently using an older one', async () => {
    fs.writeFileSync(path.join(fx.reviewsDir, `${daysAgo(2)}.json`), review(daysAgo(2), [{ id: 'a', verdict: 'live', commitments: [] }]));
    fs.writeFileSync(path.join(fx.reviewsDir, `${today()}.json`), '{ broken');
    const res = await request(appFor(ctxFor(fx))).get('/maturation/board');
    expect(res.body.reviewDate).toBe(daysAgo(2));
    expect(res.body.sources).toContainEqual(expect.objectContaining({ name: `review:${today()}.json`, ok: false, reason: 'invalid-json' }));
  });

  it('follow-up reads unknown when the commitment tracker is not running', async () => {
    fs.writeFileSync(path.join(fx.reviewsDir, `${today()}.json`), review(today(), [{ id: 'a', verdict: 'stalled', commitments: ['CMT-1'] }]));
    const res = await request(appFor(ctxFor(fx, { commitmentTracker: null }))).get('/maturation/board');
    expect(res.body.features[0].followUp.state).toBe('unknown');
  });

  it('serves the owners and review parts for peers', async () => {
    fs.writeFileSync(path.join(fx.reviewsDir, `${today()}.json`), review(today(), [{ id: 'a', verdict: 'stalled', commitments: ['CMT-1'] }]));
    const app = appFor(ctxFor(fx));
    const owners = await request(app).get('/maturation/board?scope=local&part=owners');
    expect(owners.body).toMatchObject({ schema: 'maturation-board/1', part: 'owners', reviewDigest: { date: today(), featureCount: 1 } });
    const rv = await request(app).get('/maturation/board?scope=local&part=review');
    expect(rv.body).toMatchObject({ part: 'review', date: today(), hash: owners.body.reviewDigest.hash });
    expect(rv.body.commitments[0]).toMatchObject({ id: 'CMT-1', checkInAt: '2026-10-05T00:00:00Z' });
  });

  it('pool: takes review rows from the machine with the newest review and tags peer facts', async () => {
    // Peer holds the newest review; self holds an older one.
    const peerFx = makeFixture();
    fs.writeFileSync(path.join(peerFx.reviewsDir, `${today()}.json`), review(today(), [{ id: 'feat.a', verdict: 'regressed', evidence: 'peer read', commitments: ['CMT-1'] }]));
    fs.writeFileSync(path.join(fx.reviewsDir, `${daysAgo(3)}.json`), review(daysAgo(3), [{ id: 'feat.a', verdict: 'live', commitments: [] }]));
    const peerApp = appFor(ctxFor(peerFx, { meshSelfId: 'm_peer' }));
    const server = http.createServer(peerApp);
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const res = await request(appFor(ctxFor(fx, { resolvePeerUrls: () => [{ machineId: 'm_peer', url: `http://127.0.0.1:${port}`, kind: 'lan' }] })))
      .get('/maturation/board?scope=pool');
    rm(peerFx.root);
    expect(res.status).toBe(200);
    expect(res.body.reviewMachine).toBe('Peer');
    expect(res.body.reviewDate).toBe(today());
    const a = res.body.features.find((f: { id: string }) => f.id === 'feat.a');
    expect(a.review.verdict).toBe('regressed');
    expect(a.followUp.items[0]).toMatchObject({ ref: 'CMT-1' });
    expect(new Set(a.owners.map((o: { machine: string }) => o.machine))).toEqual(new Set(['Self', 'Peer']));
  });

  it('pool: a peer that does not answer is named, and a future-dated peer review is refused', async () => {
    fs.writeFileSync(path.join(fx.reviewsDir, `${today()}.json`), review(today(), [{ id: 'a', verdict: 'live', commitments: [] }]));
    const liar = express().get('/maturation/board', (_req, res) => {
      res.json({ schema: 'maturation-board/1', part: 'owners', owners: [], reviewDigest: { date: '2099-01-01', hash: 'x'.repeat(64), featureCount: 1 } });
    });
    const server = http.createServer(liar);
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const res = await request(appFor(ctxFor(fx, { resolvePeerUrls: () => [
      { machineId: 'm_liar', url: `http://127.0.0.1:${port}`, kind: 'lan' },
      { machineId: 'm_dead', url: 'http://127.0.0.1:1', kind: 'lan' },
    ] }))).get('/maturation/board?scope=pool');
    expect(res.status).toBe(200);
    expect(res.body.reviewDate).toBe(today());
    expect(res.body.reviewMachine).toBe('Self');
    expect(res.body.sources).toContainEqual(expect.objectContaining({ name: 'may-be-superseded', ok: false }));
    expect(res.body.sources.some((s: { name: string; machine: string }) => s.name === 'review-candidate' && s.machine === 'm_liar')).toBe(false);
  });
});

describe('reviews directory containment', () => {
  it('refuses a directory outside the project, under .instar, or a symlink escape', () => {
    const fx = makeFixture();
    try {
      expect(resolveReviewsDir(fx.projectDir, '../').error).toBe('reviews-dir-outside-project');
      expect(resolveReviewsDir(fx.projectDir, '.instar').error).toBe('reviews-dir-forbidden');
      const outside = fs.mkdtempSync(path.join(fx.root, 'out-'));
      fs.symlinkSync(outside, path.join(fx.projectDir, 'escape'));
      expect(resolveReviewsDir(fx.projectDir, 'escape').error).toBe('reviews-dir-outside-project');
      expect(resolveReviewsDir(fx.projectDir, undefined).dir).toBe(fs.realpathSync(fx.reviewsDir));
    } finally {
      rm(fx.root);
    }
  });

  it('refuses a symlinked review file', async () => {
    const fx = makeFixture();
    try {
      const target = path.join(fx.root, 'secret.json');
      fs.writeFileSync(target, review(today(), [{ id: 'a', verdict: 'live', commitments: [] }]));
      fs.symlinkSync(target, path.join(fx.reviewsDir, `${today()}.json`));
      const res = await request(appFor(ctxFor(fx))).get('/maturation/board');
      expect(res.body.reviewState).toBe('none');
      expect(res.body.sources).toContainEqual(expect.objectContaining({ reason: 'not-a-regular-file' }));
    } finally {
      rm(fx.root);
    }
  });
});
