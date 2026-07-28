/**
 * Feature-alive integration tests for the Durable Inbound Message Queue API
 * (spec §Observability): GET /pool/queue over the REAL router with a REAL
 * QueueDrainLoop on a REAL SQLite store — plus the ships-dark contract
 * (engine absent → 503, the production default state).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { PendingInboundStore } from '../../src/core/PendingInboundStore.js';
import { QueueDrainLoop } from '../../src/core/QueueDrainLoop.js';
import {
  DEFAULT_INBOUND_QUEUE_CONFIG,
  DEFAULT_HOLD_FOR_STABILITY_CONFIG,
} from '../../src/core/inboundQueueConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('Durable Inbound Message Queue — GET /pool/queue', () => {
  let dir: string;
  let server: Server;
  let store: PendingInboundStore | null = null;

  afterEach(async () => {
    await server.close();
    store?.close();
    store = null;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/inbound-queue-route.test.ts' });
  });

  async function start(engine: QueueDrainLoop | null): Promise<void> {
    const ctx: any = {
      config: { authToken: 'test', stateDir: dir, port: 0 },
      stateDir: dir,
      coordinator: null,
      getInboundQueue: () => engine,
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  }

  function makeEngine(): QueueDrainLoop {
    store = PendingInboundStore.open('echo', dir);
    const engine = new QueueDrainLoop({
      store,
      qcfg: { ...DEFAULT_INBOUND_QUEUE_CONFIG, enabled: true, dryRun: false },
      hcfg: { ...DEFAULT_HOLD_FOR_STABILITY_CONFIG, enabled: true },
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
      reportLoss: () => {},
      reportPossiblyNotInjected: () => {},
      log: () => {},
      reportDegradation: () => {},
      now: () => Date.now(),
      mono: () => performance.now(),
      bootSessionId: 'boot-1',
    });
    engine.onLeaseAcquired(null);
    return engine;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iq-route-'));
  });

  it('SHIPS-DARK contract: engine absent → 503 naming the flag (the production default)', async () => {
    await start(null);
    const res = await fetch(`${server.url}/pool/queue`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('multiMachine.sessionPool.inboundQueue');
  });

  it('FEATURE-ALIVE: engine present → 200 with counts/counters/tenure; custody flows through to the route', async () => {
    const engine = makeEngine();
    await start(engine);

    // Take custody of two messages, drain one to delivered.
    expect(engine.enqueueLive({ sessionKey: '101', messageId: 'm1', payload: 'hello' }, 'ownership-contention').result).toBe('queued');
    expect(engine.enqueueLive({ sessionKey: '202', messageId: 'm2', payload: 'world' }, 'placement-blocked:x').result).toBe('queued');
    await engine.runDrainPass('test');

    const res = await fetch(`${server.url}/pool/queue`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.tenure).toBe('m_a#1');
    expect(body.paused).toBe(false);
    // Both drained to delivered (clean): delivered24h counts them; the
    // unconfirmed class is empty and EXCLUDED from delivered24h by contract.
    expect(body.counts.delivered24h).toBe(2);
    expect(body.counts.deliveredUnconfirmed24h).toBe(0);
    expect(body.counts.queued).toBe(0);
    expect(body.counters.possiblyNotInjected).toBe(0);
    expect(body.custodyDurability).toBe('unknown');
  });

  it('delivered24h EXCLUDES possibly-not-injected rows (success never overstates)', async () => {
    const engine = makeEngine();
    await start(engine);
    engine.enqueueLive({ sessionKey: '303', messageId: 'm3', payload: 'x' }, 'r');
    // Simulate a caught inject error after receipt: dispatch dep override is
    // not reachable here, so drive the store directly through the engine's
    // public surface — enqueue a second engine? Simpler: use the dispatch dep
    // built into makeEngine (clean local-delivered), then assert the split
    // via a direct store transition for the unconfirmed class.
    await engine.runDrainPass('test');
    const row = store!.getRowByCanonicalId('303', 'm3')!;
    expect(row.state).toBe('delivered');
    // Mint an unconfirmed delivery directly (the §3.4 shape).
    const out = store!.enqueue({ sessionKey: '404', messageId: 'm4', payload: 'y', senderEnvelope: null, topicMetadata: undefined, reason: 'r', tenure: 'm_a#1', nowIso: new Date().toISOString(), monoMs: 1, bootSessionId: 'boot-1' }, { maxPerSession: 50, maxTotal: 500, hardMaxTotal: 1000, maxPayloadBytes: 65536 }) as { seq: number };
    store!.claim(out.seq, new Date().toISOString());
    store!.transition(out.seq, 'claimed', 'delivered', { nowIso: new Date().toISOString(), deliveredUnconfirmed: true });

    const res = await fetch(`${server.url}/pool/queue`);
    const body = await res.json();
    expect(body.counts.delivered24h).toBe(1); // m3 only
    expect(body.counts.deliveredUnconfirmed24h).toBe(1); // m4
  });
});
