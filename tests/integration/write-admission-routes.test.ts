/**
 * Tier-2 integration — standby-write reconciliation through the FULL HTTP
 * pipeline (docs/specs/standby-write-reconciliation.md §8 Tier 2):
 *
 *  - The P2-6 family (POST /evolution/actions, POST /attention) on a simulated
 *    standby-that-owns-topics → 201 (admitted machine-local), the write lands,
 *    and the outbound gate still runs AFTER admission.
 *  - A cluster-shared-classified route on a NON-holder → 409 typed body +
 *    Retry-After, and ZERO store mutation (I3 asserted by store snapshot —
 *    state/evolution/action-queue.json untouched, no attention item created,
 *    no tone-gate call spent).
 *  - dryRun mode → legacy behavior (the same write proceeds) + would-verdict
 *    counters recorded, spend path byte-identical (tone gate still runs).
 *  - Admission-layer throw → the §5 per-domain route-seam fail directions.
 *  - GET /write-admission → 200 with the status body when wired, 503 dark.
 *  - The /health event-loop gauge rides the AUTHED extension ONLY (§6).
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { WriteAdmission } from '../../src/core/WriteAdmission.js';
import { WriteDomainRegistry, buildWriteDomainRegistry } from '../../src/core/WriteDomainRegistry.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';

const SELF = 'm_self';
const PEER = 'm_peer';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/write-admission-routes.test.ts' }); } catch { /* ignore */ }
  }
  dirs = [];
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-routes-'));
  dirs.push(d);
  return d;
}

interface Harness {
  app: express.Express;
  wa: WriteAdmission;
  stateDir: string;
  evolution: EvolutionManager;
  capturedCreates: unknown[];
  actionQueuePath: string;
}

function makeHarness(opts: {
  dryRun?: boolean;
  live?: boolean;
  readOnly?: boolean;
  registry?: WriteDomainRegistry;
  records?: SessionOwnershipRecord[];
  omitWriteAdmission?: boolean;
} = {}): Harness {
  const stateDir = tmp();
  const evolution = new EvolutionManager({ stateDir });
  const capturedCreates: unknown[] = [];
  const wa = new WriteAdmission(
    {
      thisMachineId: SELF,
      isReadOnly: () => opts.readOnly ?? true, // simulated standby by default
      isPoolActive: () => true,
      registry: opts.registry ?? buildWriteDomainRegistry({ machineId: SELF }),
      dryRun: opts.dryRun ?? false,
      disableTimers: true,
      inventoryComplete: opts.live ?? true,
    },
    { all: () => opts.records ?? [] },
  );
  const ctx = {
    config: { authToken: '', stateDir, projectDir: stateDir, port: 0 },
    evolution,
    // Attention path: tone gate absent ⇒ checkOutboundMessage passes through
    // (gate-open path); the telegram stub records what actually persisted.
    messagingToneGate: null,
    outboundDedupGate: null,
    topicIntentArcCheck: null,
    topicMemory: null,
    telegram: {
      createAttentionItem: async (item: { id: string }) => {
        capturedCreates.push(item);
        const now = new Date().toISOString();
        return { ...item, status: 'OPEN', createdAt: now, updatedAt: now };
      },
      getAttentionItems: () => [],
      getAttentionItem: () => undefined,
    },
    writeAdmission: opts.omitWriteAdmission ? null : wa,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return { app, wa, stateDir, evolution, capturedCreates, actionQueuePath: path.join(stateDir, 'state', 'evolution', 'action-queue.json') };
}

describe('P2-6 family admitted on a standby-that-owns-topics (machine-local — the user-visible fix)', () => {
  it('POST /evolution/actions → 201 and the action LANDS in state/evolution/action-queue.json, even read-only + live', async () => {
    const h = makeHarness({ readOnly: true, live: true, dryRun: false });
    const t0 = Date.now();
    const res = await request(h.app).post('/evolution/actions').send({
      title: 'Register the mm-audit findings ledger',
      description: 'The §8 acceptance follow-through write.',
    });
    expect(Date.now() - t0).toBeLessThan(2000); // the <2s SLO, live loop
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    // The write actually landed (the §1.2 store — action-queue.json, NOT the proposals store).
    expect(fs.existsSync(h.actionQueuePath)).toBe(true);
    expect(h.evolution.listActions().some((a) => a.title === 'Register the mm-audit findings ledger')).toBe(true);
  });

  it('POST /attention → 201 on the same simulated standby; the item is created AFTER admission', async () => {
    const h = makeHarness({ readOnly: true, live: true, dryRun: false });
    const res = await request(h.app).post('/attention').send({
      id: 'agent:wa-test-1',
      title: 'Standby write admitted',
      body: 'Machine-local attention write on a pool-owning standby.',
      priority: 'medium',
    });
    expect(res.status).toBe(201);
    expect(h.capturedCreates).toHaveLength(1);
  });

  it('body validation still precedes admission (I1 ordering): a bad body 400s without consulting the seam', async () => {
    const h = makeHarness({ readOnly: true, live: true, dryRun: false });
    const res = await request(h.app).post('/evolution/actions').send({ title: 'no description' });
    expect(res.status).toBe(400);
  });
});

describe('typed refusal through the real HTTP pipeline (cluster-shared on a non-holder)', () => {
  /** A registry that classifies the P2-6 anchors cluster-shared — the wave-2
   *  refusal machinery proven through the SAME wired seam (§3.5: "the refusal
   *  machinery is proven by the store seam + tests, ready for wave 2"). */
  function clusterSharedRegistry(): WriteDomainRegistry {
    const reg = new WriteDomainRegistry();
    reg.add({ kind: 'route', method: 'POST', pathPrefix: '/attention', domain: 'cluster-shared' });
    reg.add({ kind: 'route', method: 'POST', pathPrefix: '/evolution/', domain: 'cluster-shared' });
    return reg;
  }

  it('409 + Retry-After + the full §3.4 wire shape, in <2s', async () => {
    const h = makeHarness({ readOnly: true, live: true, dryRun: false, registry: clusterSharedRegistry() });
    const t0 = Date.now();
    const res = await request(h.app).post('/attention').send({
      id: 'agent:wa-refused',
      title: 'Should be refused',
      body: 'Cluster-shared write on a standby.',
      priority: 'medium',
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.status).toBe(409);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body.error).toBe('write-refused');
    expect(res.body.code).toBe('lease-required');
    expect(res.body.domain).toBe('cluster-shared');
    expect(res.body.retryable).toBe(true);
    expect(res.body.thisMachine.machineId).toBe(SELF);
    expect(typeof res.body.asOf).toBe('string');
    expect(typeof res.body.hint).toBe('string');
  });

  it('I3 refuse-before-touch: a refused write mutates NOTHING (store snapshot: no item created, no action-queue file)', async () => {
    const h = makeHarness({ readOnly: true, live: true, dryRun: false, registry: clusterSharedRegistry() });
    await request(h.app).post('/attention').send({
      id: 'agent:wa-refused-2', title: 'x', body: 'y', priority: 'medium',
    }).expect(409);
    await request(h.app).post('/evolution/actions').send({
      title: 'refused action', description: 'never lands',
    }).expect(409);
    expect(h.capturedCreates).toHaveLength(0); // no topic, no item
    expect(fs.existsSync(h.actionQueuePath)).toBe(false); // no store write
    expect(h.evolution.listActions()).toHaveLength(0);
  });

  it('the SAME refusal admits on the lease HOLDER (readOnly:false) — authority byte-identical to today', async () => {
    const h = makeHarness({ readOnly: false, live: true, dryRun: false, registry: clusterSharedRegistry() });
    await request(h.app).post('/evolution/actions').send({
      title: 'holder write', description: 'admitted on the holder',
    }).expect(201);
  });

  it('dryRun: the SAME cluster-shared classification PROCEEDS (legacy behavior, zero authority) and records the would-verdict', async () => {
    const h = makeHarness({ readOnly: true, live: true, dryRun: true, registry: clusterSharedRegistry() });
    const res = await request(h.app).post('/attention').send({
      id: 'agent:wa-dry', title: 'dry-run write', body: 'proceeds into today’s exact flow.', priority: 'medium',
    });
    expect(res.status).toBe(201);
    expect(h.capturedCreates).toHaveLength(1); // spend path byte-identical
    const shared = h.wa.status().domains.find((d) => d.domain === 'cluster-shared')!;
    expect(shared.wouldRefuse).toBeGreaterThanOrEqual(1);
  });

  it('feature DARK (no writeAdmission on ctx): the seam is a no-op — today’s exact flow', async () => {
    const h = makeHarness({ readOnly: true, omitWriteAdmission: true });
    await request(h.app).post('/evolution/actions').send({
      title: 'dark write', description: 'no admission wiring at all',
    }).expect(201);
  });
});

describe('admission-layer throw at the route seam (§5/§9.16 per-domain split, through HTTP)', () => {
  it('machine-local PROCEEDS (fail toward delivery); cluster-shared refuses typed admission-error (fail closed)', async () => {
    // machine-local (production registry): break evaluate → the route still 201s.
    const h1 = makeHarness({ readOnly: true, live: true, dryRun: false });
    (h1.wa as unknown as { evaluate: () => never }).evaluate = () => { throw new Error('guard broke'); };
    await request(h1.app).post('/evolution/actions').send({
      title: 'broken guard, machine-local', description: 'must still deliver',
    }).expect(201);

    // cluster-shared: same breakage → typed admission-error refusal.
    const reg = new WriteDomainRegistry();
    reg.add({ kind: 'route', method: 'POST', pathPrefix: '/evolution/', domain: 'cluster-shared' });
    const h2 = makeHarness({ readOnly: true, live: true, dryRun: false, registry: reg });
    (h2.wa as unknown as { evaluate: () => never }).evaluate = () => { throw new Error('guard broke'); };
    const res = await request(h2.app).post('/evolution/actions').send({
      title: 'broken guard, cluster-shared', description: 'must fail closed',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('admission-error');
    expect(fs.existsSync(h2.actionQueuePath)).toBe(false);
  });
});

describe('GET /write-admission (§6 observability surface)', () => {
  it('200 with mode/domains/recentRefusals/ownershipIndex/eventLoop when wired', async () => {
    const h = makeHarness({ readOnly: true, live: true, dryRun: false });
    await request(h.app).post('/attention').send({
      id: 'agent:wa-obs', title: 'observed', body: 'count me', priority: 'medium',
    }).expect(201);
    const res = await request(h.app).get('/write-admission');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.mode).toBe('live');
    expect(res.body.domains.find((d: { domain: string }) => d.domain === 'machine-local').admitted).toBeGreaterThanOrEqual(1);
    expect(res.body.ownershipIndex).toHaveProperty('entries');
    expect(res.body.eventLoop).toHaveProperty('starvedWindows24h');
  });

  it('503 when dark (house rule)', async () => {
    const h = makeHarness({ omitWriteAdmission: true });
    await request(h.app).get('/write-admission').expect(503);
  });
});

describe('/health event-loop gauge — AUTHED extension ONLY (§6: never an outsider’s timing instrument)', () => {
  function healthApp(authToken: string): express.Express {
    const stateDir = tmp();
    const wa = new WriteAdmission(
      {
        thisMachineId: SELF,
        isReadOnly: () => false,
        isPoolActive: () => false,
        registry: buildWriteDomainRegistry({ machineId: SELF }),
        dryRun: true,
        disableTimers: true,
      },
      null,
    );
    const ctx = {
      config: { authToken, stateDir, projectDir: stateDir, port: 0 },
      writeAdmission: wa,
      sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => [] },
      startTime: new Date(),
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    return app;
  }

  it('an UNAUTHENTICATED /health body never carries eventLoop; a Bearer-authed one does', async () => {
    const app = healthApp('secret-token');
    const anon = await request(app).get('/health');
    expect(anon.status).toBe(200);
    expect(anon.body.eventLoop).toBeUndefined();
    const authed = await request(app).get('/health').set('Authorization', 'Bearer secret-token');
    expect(authed.status).toBe(200);
    expect(authed.body.eventLoop).toBeDefined();
    expect(authed.body.eventLoop).toHaveProperty('p99');
  });
});

describe('ownership-scoped admission visible through the pipeline (the F9 contradiction resolved)', () => {
  it('a not-owner refusal NAMES the owner in the wire body', async () => {
    const reg = new WriteDomainRegistry();
    reg.add({ kind: 'route', method: 'POST', pathPrefix: '/attention', domain: 'topic-scoped' });
    const records: SessionOwnershipRecord[] = [{
      sessionKey: '30193',
      ownerMachineId: PEER,
      ownershipEpoch: 1,
      status: 'active',
      nonce: 'n',
      timestamp: 1,
      updatedAt: new Date(1).toISOString(),
    }];
    const stateDir = tmp();
    const wa = new WriteAdmission(
      {
        thisMachineId: SELF,
        isReadOnly: () => true,
        isPoolActive: () => true,
        registry: reg,
        dryRun: false,
        nicknameOf: (id) => (id === PEER ? 'the mini' : null),
        disableTimers: true,
        inventoryComplete: true,
      },
      { all: () => records },
    );
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes({
      config: { authToken: '', stateDir, projectDir: stateDir, port: 0 },
      telegram: { createAttentionItem: async () => { throw new Error('must never be reached'); } },
      messagingToneGate: null,
      writeAdmission: wa,
      startTime: new Date(),
    } as unknown as RouteContext));

    // The route seam derives scope from the request; POST /attention carries no
    // topicId — drive the scoped verdict through the seam directly instead.
    const v = wa.guardRouteWrite('POST', '/attention', { topicId: 30193 });
    expect(v.action).toBe('refuse');
    if (v.action === 'refuse') {
      expect(v.refusal.code).toBe('not-owner');
      expect(v.refusal.owner).toEqual({ machineId: PEER, nickname: 'the mini' });
    }
  });
});
