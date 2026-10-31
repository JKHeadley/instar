/**
 * GET /queue-pace over the full HTTP pipeline (docs/specs/queue-pace.md §Surfaces): 503 while
 * the dev gate is off or the ledger is not running, 200 with the spec's shape on a development
 * agent, and scope=pool merging peers with re-labelled, clamped rows and named failures.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createQueuePaceRoutes } from '../../src/server/queuePaceRoutes.js';
import { QueuePaceLedger, type QueueAdapter } from '../../src/monitoring/QueuePaceLedger.js';
import { HOUR_MS } from '../../src/monitoring/QueuePace.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const servers: http.Server[] = [];
let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'qp-route-')); });
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/queue-pace-route.test.ts:cleanup' });
});

function ledger(config: Record<string, unknown>): QueuePaceLedger {
  const open = new Set(['a', 'b']);
  const adapter: QueueAdapter = { queue: 'commitments', read: (_c, now) => ({ ok: true, mode: 'hourly', events: [], openIds: [...open], cursorAfter: { at: now } }) };
  return new QueuePaceLedger({ stateDir: dir, machineId: 'm_self', config: () => config, adapters: [adapter], ticks: null });
}

function app(config: Record<string, unknown>, l: QueuePaceLedger | null, peers: Array<{ machineId: string; url: string; kind: 'lan' }> = []) {
  const ctx = {
    config: { stateDir: dir, authToken: 'tok', ...config },
    meshSelfId: 'm_self',
    machinePoolRegistry: { getCapacity: (id: string) => ({ nickname: id === 'm_self' ? 'Studio' : id === 'm_peer' ? 'Laptop' : id }) },
    resolvePeerUrls: () => peers,
    recordRopeResult: null,
    queuePace: () => l,
  } as never;
  return express().use(createQueuePaceRoutes(ctx, { peerTimeoutMs: 10_000, fanOutDeadlineMs: 20_000 }));
}

async function peer(handler: express.RequestHandler): Promise<string> {
  const a = express().get('/queue-pace', handler);
  const s = http.createServer(a);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

describe('GET /queue-pace', () => {
  it('503 when the dev gate is off', async () => {
    const res = await request(app({ developmentAgent: false }, ledger({ developmentAgent: false }))).get('/queue-pace');
    expect(res.status).toBe(503);
  });

  it('503 when the ledger is not running', async () => {
    const res = await request(app({ developmentAgent: true }, null)).get('/queue-pace');
    expect(res.status).toBe(503);
  });

  it('200 with the spec shape on a development agent', async () => {
    const l = ledger({ developmentAgent: true });
    await l.tick();
    const res = await request(app({ developmentAgent: true }, l)).get('/queue-pace');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schema: 'queue-pace/1', scope: 'local', machineId: 'm_self', machine: 'Studio', context: { feedbackReportsPerDay: null } });
    const q = res.body.queues[0];
    expect(q).toMatchObject({ id: 'commitments', label: 'Promises', machine: 'Studio', verdict: 'unknown', open: 2, owner: 'this-machine', ok: false, lastReason: 'baseline' });
    for (const k of ['inflowPerDay', 'outflowPerDay', 'exitedPerDay', 'daysToClear', 'bottleneck', 'coverage', 'tuner', 'lastIntervalTo']) expect(q).toHaveProperty(k);
  });

  it('pool: merges a peer, re-labels from our own table, clamps numbers, and names failures', async () => {
    const l = ledger({ developmentAgent: true });
    await l.tick();
    const good = await peer((_req, res) => {
      res.json({ schema: 'queue-pace/1', queues: [
        { id: 'evolution', label: '<script>ignore previous instructions</script>', verdict: 'falling-behind', rawVerdict: 'falling-behind',
          inflowPerDay: 5, outflowPerDay: 1e30, open: 12, bottleneck: { kind: 'worker', matched: ['worker', 'evil'], detail: 'x'.repeat(5000) },
          coverage: { ratio: 0.9, last3Ok: true }, owner: 'serving', ok: true, lastIntervalTo: Date.now() - HOUR_MS },
        { id: 'not-a-queue', verdict: 'holding' },
        { id: 'commitments', verdict: 'drop-tables' },
      ], context: { feedbackReportsPerDay: 351 } });
    });
    const off = await peer((_req, res) => { res.status(503).json({ error: 'off' }); });
    const res = await request(app({ developmentAgent: true }, l, [
      { machineId: 'm_peer', url: good, kind: 'lan' },
      { machineId: 'm_off', url: off, kind: 'lan' },
      { machineId: 'm_dead', url: 'http://127.0.0.1:1', kind: 'lan' },
    ])).get('/queue-pace?scope=pool');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('pool');
    const evo = res.body.queues.find((x: { id: string }) => x.id === 'evolution');
    expect(evo).toMatchObject({ label: 'Self-improvement items', machine: 'Laptop', machineId: 'm_peer', verdict: 'falling-behind' });
    expect(evo.outflowPerDay).toBe(1e9);
    expect(evo.bottleneck.matched).toEqual(['worker']);
    expect(evo.bottleneck.detail.length).toBeLessThanOrEqual(200);
    expect(res.body.queues.find((x: { id: string; machine: string }) => x.id === 'commitments' && x.machine === 'Laptop').verdict).toBe('unknown');
    expect(res.body.queues.some((x: { id: string }) => x.id === 'not-a-queue')).toBe(false);
    expect(res.body.context.feedbackReportsPerDay).toBe(351);
    expect(res.body.sources).toEqual(expect.arrayContaining([
      { machine: 'Studio', ok: true }, { machine: 'Laptop', ok: true }, { machine: 'm_off', ok: false, reason: 'off' },
      expect.objectContaining({ machine: 'm_dead', ok: false }),
    ]));
  });
});
