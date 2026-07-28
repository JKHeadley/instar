/**
 * Tier-2 integration tests for the A2A peer-health routes
 * (A2A-DURABLE-DELIVERY-SPEC.md): GET /threadline/peers/health and
 * /threadline/peers/:fp/health over the full HTTP pipeline. Verifies the routes
 * compose real tracker data when the feature is wired, honor the staleAfterMs
 * query param, and 503 cleanly when the tracker is absent (feature-not-alive).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { A2ADeliveryTracker } from '../../src/threadline/A2ADeliveryTracker.js';

const FP = '8c7928aa9f04fbda947172a2f9b2d81a';

function appWith(tracker: A2ADeliveryTracker | null): express.Express {
  const ctx = {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp', port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: {} as any,
    state: {} as any,
    a2aDeliveryTracker: tracker,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

describe('GET /threadline/peers/health (integration)', () => {
  let tracker: A2ADeliveryTracker;
  let app: express.Express;

  beforeEach(() => {
    tracker = A2ADeliveryTracker.openMemory();
    app = appWith(tracker);
  });
  afterEach(() => tracker?.close());

  it('returns 200 with an empty peer list before any traffic', async () => {
    const res = await request(app).get('/threadline/peers/health');
    expect(res.status).toBe(200);
    expect(res.body.peers).toEqual([]);
    expect(res.body.count).toBe(0);
    expect(res.body.staleCount).toBe(0);
  });

  it('composes health for a peer with sent + acked + inbound', async () => {
    tracker.recordSent({ messageId: 'm1', peerFp: FP, peerName: 'dawn', threadId: 't1' });
    tracker.recordAck('m1');
    tracker.recordInboundFrom(FP, 'dawn');
    const res = await request(app).get(`/threadline/peers/${FP}/health`);
    expect(res.status).toBe(200);
    expect(res.body.peerFp).toBe(FP);
    expect(res.body.lastSentAt).not.toBeNull();
    expect(res.body.lastAckedAt).not.toBeNull();
    expect(res.body.lastInboundAt).not.toBeNull();
    expect(res.body.pendingCount).toBe(0);
    expect(res.body.stale).toBe(false);
  });

  it('reports a pending (unacked) message and surfaces it in the all-peers list', async () => {
    tracker.recordSent({ messageId: 'm1', peerFp: FP, peerName: 'dawn' });
    const all = await request(app).get('/threadline/peers/health');
    expect(all.status).toBe(200);
    expect(all.body.count).toBe(1);
    expect(all.body.peers[0].peerFp).toBe(FP);
    expect(all.body.peers[0].pendingCount).toBe(1);
  });

  it('honors the staleAfterMs query param to flag a stuck channel', async () => {
    // Send with an old timestamp, then ask for a tiny stale window → stale.
    tracker.recordSent({ messageId: 'm1', peerFp: FP, sentAt: '2000-01-01T00:00:00Z' });
    const res = await request(app).get(`/threadline/peers/${FP}/health?staleAfterMs=1000`);
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    const all = await request(app).get('/threadline/peers/health?staleAfterMs=1000');
    expect(all.body.staleCount).toBe(1);
  });

  it('an unknown peer returns an all-null, not-stale health record (200, not 404)', async () => {
    const res = await request(app).get('/threadline/peers/unknownfp/health');
    expect(res.status).toBe(200);
    expect(res.body.lastSentAt).toBeNull();
    expect(res.body.pendingCount).toBe(0);
    expect(res.body.stale).toBe(false);
  });

  it('503s cleanly when the tracker is not initialized (feature not alive)', async () => {
    const noTracker = appWith(null);
    const a = await request(noTracker).get('/threadline/peers/health');
    const b = await request(noTracker).get(`/threadline/peers/${FP}/health`);
    expect(a.status).toBe(503);
    expect(b.status).toBe(503);
  });
});
