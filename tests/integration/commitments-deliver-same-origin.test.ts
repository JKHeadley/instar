// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration (fb-6a8328a1): POST /commitments/:id/deliver over the real HTTP
 * route when the merged view holds TWO copies of ONE commitment — a restored
 * own copy whose origin is a peer, plus that peer's own replica. Before the
 * fix the route answered 409 "ambiguous across machines" even with ?origin=,
 * so a finished promise could not be closed at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { CommitmentMutatePayload } from '../../src/core/CommitmentMutation.js';

const SELF = 'm_studio_new';
const PEER = 'm_laptop';

describe('commitments deliver — same-origin copies collapse to the origin (HTTP route)', () => {
  let dir: string;
  let tracker: CommitmentTracker;
  let forwarded: Array<{ owner: string; payload: CommitmentMutatePayload }>;

  /** Seed the OWN store with a record whose origin is the PEER (a restored copy). */
  function seedRestoredCopy(): string {
    const seed = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir), originMachineId: PEER });
    const c = seed.record({ userRequest: 'get the report delivered', type: 'one-time-action', source: 'manual' } as Parameters<CommitmentTracker['record']>[0]);
    seed.stop();
    return c.id;
  }

  function app(replicaRecords: Array<Record<string, unknown>>, replicaOwner = PEER) {
    tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir), originMachineId: SELF });
    const a = express();
    a.use(express.json());
    a.use(createRoutes({
      config: { authToken: 'test', stateDir: dir, port: 0 },
      stateDir: dir,
      commitmentTracker: tracker,
      meshSelfId: SELF,
      commitmentReplicaStore: {
        allReplicas: () => [{ ownerMachineId: replicaOwner, receivedAt: new Date().toISOString(), records: replicaRecords }],
      },
      forwardCommitmentMutate: async (owner: string, payload: CommitmentMutatePayload) => {
        forwarded.push({ owner, payload });
        return { kind: 'verdict', outcome: { verdict: 'applied', status: 'delivered' } };
      },
    } as any));
    return a;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdso-'));
    forwarded = [];
  });
  afterEach(() => {
    tracker?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/commitments-deliver-same-origin.test.ts' });
  });

  it('?origin=<peer> with a restored own copy + the peer replica → forwards to the origin (200), not 409', async () => {
    const id = seedRestoredCopy();
    const own = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'commitments.json'), 'utf-8')).commitments[0];
    const res = await request(app([{ ...own }])).post(`/commitments/${id}/deliver?origin=${PEER}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.owner).toBe(PEER);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].owner).toBe(PEER);
    expect(forwarded[0].payload.op).toBe('deliver');
    // The stale local copy is NOT mutated — authority is the origin.
    expect(tracker.getAll().find((c) => c.id === id)?.status).toBe('pending');
  });

  it('a different-origin collision with a bare id still answers 409', async () => {
    const id = seedRestoredCopy();
    const own = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'commitments.json'), 'utf-8')).commitments[0];
    const res = await request(app([{ ...own, originMachineId: 'm_other' }], 'm_other')).post(`/commitments/${id}/deliver`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('ambiguous');
    expect(forwarded).toHaveLength(0);
  });
});
