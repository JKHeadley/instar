/**
 * E2E lifecycle test for the Durable Inbound Message Queue (spec §Testing):
 * mirrors the production initialization sequence end-to-end —
 *
 *   boot sweep (unconditional path) → engine construction (adopting the swept
 *   store) → crash recovery drains → GET /pool/queue answers over real HTTP.
 *
 * Plus the production-DEFAULT lifecycle: a disabled boot with residual rows
 * gate-expires them (named reason, loss-reported) and the route answers 503 —
 * the ships-dark contract a fresh agent actually exhibits.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { PendingInboundStore } from '../../src/core/PendingInboundStore.js';
import { QueueDrainLoop, type LossItem } from '../../src/core/QueueDrainLoop.js';
import { runInboundQueueBootSweep } from '../../src/core/inboundQueueBootSweep.js';
import {
  DEFAULT_INBOUND_QUEUE_CONFIG,
  DEFAULT_HOLD_FOR_STABILITY_CONFIG,
  validateInboundQueueInvariants,
} from '../../src/core/inboundQueueConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('Durable Inbound Message Queue — production-init lifecycle (E2E)', () => {
  let dir: string;
  let server: TestServer | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iq-e2e-'));
  });
  afterEach(async () => {
    await server?.close();
    server = null;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/inbound-queue-lifecycle.test.ts' });
  });

  /** Seed a prior boot's store: one queued row + one crashed-mid-dispatch row. */
  function seedPriorBoot(): void {
    const store = PendingInboundStore.open('echo', dir);
    store.observeLeaseClaim('m_a', null);
    const a = store.enqueue({ sessionKey: '101', messageId: 'm1', payload: 'queued before crash', senderEnvelope: { firstName: 'J' }, topicMetadata: undefined, reason: 'ownership-contention', tenure: 'm_a#1', nowIso: new Date().toISOString(), monoMs: 1, bootSessionId: 'old-boot' }, { maxPerSession: 50, maxTotal: 500, hardMaxTotal: 1000, maxPayloadBytes: 65536 }) as { seq: number };
    void a;
    const b = store.enqueue({ sessionKey: '202', messageId: 'm2', payload: 'claimed at crash', senderEnvelope: null, topicMetadata: undefined, reason: 'ownership-contention', tenure: 'm_a#1', nowIso: new Date().toISOString(), monoMs: 2, bootSessionId: 'old-boot' }, { maxPerSession: 50, maxTotal: 500, hardMaxTotal: 1000, maxPayloadBytes: 65536 }) as { seq: number };
    store.claim(b.seq, new Date().toISOString());
    store.close();
  }

  it('ENABLED boot: sweep recovers → engine adopts the swept store → drain delivers → route 200 with the truth', async () => {
    seedPriorBoot();
    const losses: Array<{ items: LossItem[]; reason: string }> = [];

    // 1. The unconditional boot sweep (production order: BEFORE PIS recovery).
    const sweep = runInboundQueueBootSweep({
      stateDir: dir,
      agentId: 'echo',
      queueWillRun: { run: true },
      hasPisRecord: () => false,
      clearPisRecord: () => {},
      reportLoss: (items, reason) => losses.push({ items, reason }),
      reportPossiblyNotInjected: () => {},
      raiseAttention: () => {},
      log: () => {},
      nowMs: () => Date.now(),
    });
    expect(sweep.storePresent).toBe(true);
    expect(sweep.recoveredToQueued).toBe(1); // the crashed claimed row, released
    expect(sweep.store).not.toBeNull();

    // 2. Config-seam validation (the same gate production runs).
    const qcfg = { ...DEFAULT_INBOUND_QUEUE_CONFIG, enabled: true, dryRun: false };
    const hcfg = { ...DEFAULT_HOLD_FOR_STABILITY_CONFIG, enabled: true };
    expect(validateInboundQueueInvariants(qcfg, hcfg).ok).toBe(true);

    // 3. Engine adopts the SWEPT store (one open handle, single-writer).
    const engine = new QueueDrainLoop({
      store: sweep.store!,
      qcfg, hcfg,
      selfMachineId: 'm_a',
      holdsLease: () => true,
      isStopped: () => false,
      dispatchInbound: async (_msg, handover) => {
        if (!handover.commitReceipt()) return { kind: 'handover-refused' };
        return { kind: 'local-delivered' };
      },
      forceReplace: async () => true,
      holdVerdict: () => 'deliver',
      clearPisRecord: () => {},
      reportLoss: (items, reason) => losses.push({ items, reason }),
      reportPossiblyNotInjected: () => {},
      log: () => {},
      reportDegradation: () => {},
      now: () => Date.now(),
      mono: () => performance.now(),
      bootSessionId: 'new-boot',
    });
    engine.onLeaseAcquired('m_a'); // same holder re-acquire: tenure unchanged

    // 4. Tick → drain. The recovered rows are from the SAME tenure (m_a#1) but
    // a DIFFERENT boot session — fresh enough (< staleCustodyTtlMs) to deliver.
    await engine.tick();

    // 5. The route reports the lifecycle outcome over real HTTP.
    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, coordinator: null, getInboundQueue: () => engine } as any));
    server = await listen(app);
    const res = await fetch(`${server.url}/pool/queue`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts.queued).toBe(0);
    expect(body.counts.delivered24h + body.counts.deliveredUnconfirmed24h).toBe(2);
    expect(losses).toHaveLength(0); // nothing lost across the crash
  });

  it('DISABLED boot with residual rows (production default): gate-expires with the NAMED reason; route 503', async () => {
    seedPriorBoot();
    const losses: Array<{ items: LossItem[]; reason: string }> = [];
    const sweep = runInboundQueueBootSweep({
      stateDir: dir,
      agentId: 'echo',
      queueWillRun: { run: false, gateReason: 'feature-disabled' },
      hasPisRecord: () => false,
      clearPisRecord: () => {},
      reportLoss: (items, reason) => losses.push({ items, reason }),
      reportPossiblyNotInjected: () => {},
      raiseAttention: () => {},
      log: () => {},
      nowMs: () => Date.now(),
    });
    expect(sweep.gateExpired).toBe(2);
    expect(sweep.store).toBeNull();
    expect(losses[0].reason).toBe('queue-dispatch-will-not-run:feature-disabled');

    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, coordinator: null, getInboundQueue: () => null } as any));
    server = await listen(app);
    const res = await fetch(`${server.url}/pool/queue`);
    expect(res.status).toBe(503);
  });
});
