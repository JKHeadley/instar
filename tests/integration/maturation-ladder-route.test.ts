import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { FeatureEvidenceLog } from '../../src/monitoring/FeatureEvidenceLog.js';
import { MaturationLadderService } from '../../src/monitoring/MaturationLadderService.js';
import { sanitizePeerOwners } from '../../src/server/maturationBoardRoutes.js';
import { createMaturationLadderRoutes } from '../../src/server/maturationLadderRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 86_400_000;
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'tests/integration/maturation-ladder-route.test.ts' }); });

const entry = {
  id: 'monitoring.x', title: 'X', flag: { path: 'monitoring.x' }, disposition: 'ladder', final: 'default-on', risk: 'standard', tracking: { state: 'measured', plan: 'log' },
  rungs: { fleet: { soakDays: 1, advance: { kind: 'code' }, metrics: [
    { id: 'ran', role: 'ran', source: 'jsonl-log', ref: { file: 'logs/x.jsonl', where: { kind: 'fired' }, value: 'count' }, direction: 'at-least', threshold: 1, minSamples: 1, windowDays: 7 },
    { id: 'harm', role: 'harm', source: 'jsonl-log', ref: { file: 'logs/x.jsonl', where: { kind: 'error' }, value: 'count' }, direction: 'at-most', threshold: 0, minSamples: 1, windowDays: 7 },
  ] } },
};

async function app(enabled = true) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-route-'));
  roots.push(projectDir);
  fs.mkdirSync(path.join(projectDir, 'logs'));
  fs.writeFileSync(path.join(projectDir, 'logs/x.jsonl'), `${JSON.stringify({ at: new Date(Date.now() - DAY).toISOString(), kind: 'fired' })}\n`);
  const svc = new MaturationLadderService({
    projectDir, machine: 'm1',
    readRegistry: () => JSON.stringify({ schema: 'feature-ladders/1', entries: [entry] }),
    readLiveConfig: () => ({ developmentAgent: true }),
    shippedDefaults: () => ({}),
    d7: null, featureMetrics: null, guardEffective: null, commitments: null,
    holdsLease: () => true, reviewTopic: () => null, isCoherenceCritical: () => false,
    setConfig: () => undefined, isDevelopmentAgent: () => true,
  });
  await svc.refresh();
  const log = new FeatureEvidenceLog({ projectDir, machine: 'm1', instarVersion: '1.0.0' });
  const a = express();
  a.use(express.json());
  a.use(createMaturationLadderRoutes({ enabled: () => enabled, ladder: () => svc, evidence: () => log }));
  return { a, log };
}

describe('maturation ladder routes', () => {
  it('503 when off', async () => {
    const { a } = await app(false);
    for (const p of ['/maturation/ladder', '/maturation/moves']) expect((await request(a).get(p)).status).toBe(503);
    expect((await request(a).post('/maturation/evidence').send({})).status).toBe(503);
  });

  it('GET /maturation/ladder returns thresholds, now vs target, and narrows by id', async () => {
    const { a } = await app();
    const res = await request(a).get('/maturation/ladder');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schema: 'maturation-ladder/1', advisory: true, registry: 'ok', counts: { total: 1, withThresholds: 1 } });
    const f = res.body.features[0];
    expect(f).toMatchObject({ id: 'monitoring.x', rung: 'dev-agent-live', next: 'fleet' });
    expect(f.metrics.map((m: { id: string; value: number; threshold: number }) => [m.id, m.value, m.threshold])).toEqual([['ran', 1, 1], ['harm', 0, 0]]);
    expect((await request(a).get('/maturation/ladder?id=nope')).body.features).toEqual([]);
  });

  it('a move needs a reason, opinions and what was read; a code rung refuses by name', async () => {
    const { a } = await app();
    const good = { id: 'monitoring.x', target: 'fleet', reason: 'r', from: {}, opinions: [{ family: 'x' }] };
    expect((await request(a).post('/maturation/moves').send({ ...good, target: 'moon' })).status).toBe(400);
    expect((await request(a).post('/maturation/moves').send({ ...good, reason: '' })).status).toBe(400);
    expect((await request(a).post('/maturation/moves').send({ ...good, opinions: [] })).status).toBe(400);
    expect((await request(a).post('/maturation/moves').send({ ...good, from: undefined })).status).toBe(400);
    const res = await request(a).post('/maturation/moves').send(good);
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect((await request(a).post('/maturation/moves/nope/revert').send({ reason: 'x' })).body.refused).toBe('not-found');
    expect((await request(a).post('/maturation/moves/nope/revert').send({})).status).toBe(400);
  });

  it('evidence: known features only, bounds enforced, server stamps the row', async () => {
    const { a, log } = await app();
    expect((await request(a).post('/maturation/evidence').send({ featureId: 'nope', kind: 'fired', reason: 'r' })).status).toBe(400);
    expect((await request(a).post('/maturation/evidence').send({ featureId: 'monitoring.x', kind: 'nope', reason: 'r' })).status).toBe(400);
    expect((await request(a).post('/maturation/evidence').send({ featureId: 'monitoring.x', kind: 'outcome', reason: 'r' })).status).toBe(400);
    const res = await request(a).post('/maturation/evidence').send({ featureId: 'monitoring.x', kind: 'outcome', outcome: 'right', gradesEventId: 'e1', gradedBy: 'review', reason: 'checked', machine: 'forged', at: '2000-01-01' });
    expect(res.status).toBe(200);
    const row = JSON.parse(fs.readFileSync(log.filePath, 'utf-8').trim());
    expect(row).toMatchObject({ eventId: res.body.eventId, machine: 'm1', outcome: 'right', gradesEventId: 'e1' });
    expect(row.at).not.toBe('2000-01-01');
  });

  it('limits evidence per feature', async () => {
    const { a } = await app();
    let last = 200;
    for (let i = 0; i < 62; i++) last = (await request(a).post('/maturation/evidence').send({ featureId: 'monitoring.x', kind: 'fired', reason: 'r' })).status;
    expect(last).toBe(429);
  });

  it('the ladder owner source passes pool sanitising', () => {
    const out = sanitizePeerOwners([{ source: 'ladder', ownerId: 'monitoring-x', aliases: ['monitoring.x'], facts: { rung: 'dark', state: 'not-started', total: 2 } }], 'peer');
    expect(out?.[0]).toMatchObject({ source: 'ladder', machine: 'peer', facts: { rung: 'dark' } });
  });
});
