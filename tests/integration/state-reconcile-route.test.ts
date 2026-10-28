// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration — GET /state/reconcile (docs/specs/statesync-writer-agnostic-reconciler.md §7):
 * the REAL router over a REAL ReplicatedStoreReconciler built from the production seams
 * (buildReconcilerSeams) on a tmp state dir. Proves the route serves counters only — no
 * record key, no identity, and a corrupt PII file yields only a fixed lastError code — and
 * answers 503 when the reconciler is not constructed (journal dark).
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { ReplicatedStoreReconciler } from '../../src/core/ReplicatedStoreReconciler.js';
import { buildReconcilerSeams } from '../../src/core/ReplicatedStoreReconcilerWiring.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { PREF_KIND_REGISTRATION } from '../../src/core/PreferencesReplicatedStore.js';
import { RELATIONSHIP_KIND_REGISTRATION } from '../../src/core/RelationshipsReplicatedStore.js';
import { KNOWLEDGE_KIND_REGISTRATION, deriveKnowledgeRecordKey } from '../../src/core/KnowledgeReplicatedStore.js';
import { USER_KIND_REGISTRATION } from '../../src/core/UserRegistryReplicatedStore.js';
import { LEARNING_KIND_REGISTRATION } from '../../src/core/LearningsReplicatedStore.js';
import { EVOLUTION_ACTION_KIND_REGISTRATION } from '../../src/core/EvolutionActionsReplicatedStore.js';
import { KnowledgeManager } from '../../src/knowledge/KnowledgeManager.js';
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

const ORIGIN = 'm_route';

describe('GET /state/reconcile', () => {
  let dir: string;
  let server: Server | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/state-reconcile-route.test.ts' });
  });

  async function start(reconciler: ReplicatedStoreReconciler | null): Promise<void> {
    const ctx: any = {
      config: { authToken: 'test', stateDir: dir, port: 0 },
      stateDir: dir,
      coordinator: null,
      replicatedStoreReconciler: reconciler,
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  }

  function build(): { reconciler: ReplicatedStoreReconciler; appended: Record<string, unknown>[] } {
    const registry = new ReplicatedKindRegistry();
    for (const r of [PREF_KIND_REGISTRATION, RELATIONSHIP_KIND_REGISTRATION, KNOWLEDGE_KIND_REGISTRATION, USER_KIND_REGISTRATION, LEARNING_KIND_REGISTRATION, EVOLUTION_ACTION_KIND_REGISTRATION]) {
      registry.register(r);
    }
    const stores = {
      knowledge: { enabled: true },
      userRegistry: { enabled: true },
      relationships: { enabled: true },
    };
    const appended: Record<string, unknown>[] = [];
    const emitter = new ReplicatedRecordEmitter({
      journal: { emitReplicatedRecord: (_k, d) => { appended.push(d); return 'accepted'; } },
      clock: new HybridLogicalClock({ node: ORIGIN, now: () => Date.now() }),
      registry,
      origin: ORIGIN,
      stores: () => stores,
      loadWitness: () => undefined,
    });
    const reconciler = new ReplicatedStoreReconciler({
      emitter,
      reader: { loadOwnOriginRecordsAsync: async () => new Map() },
      registry,
      origin: ORIGIN,
      stores: () => stores,
      seams: buildReconcilerSeams({ stateDir: dir, relationshipsDir: path.join(dir, 'relationships'), evolution: { listLearnings: () => [], listActions: () => [] } }),
      gitCarried: async () => 'local',
      config: () => ({}),
      setTimer: () => ({}),
    });
    return { reconciler, appended };
  }

  it('503 when the reconciler is not constructed (journal dark)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-reconcile-route-'));
    await start(null);
    const res = await fetch(`${server!.url}/state/reconcile`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('reconciler-not-constructed');
  });

  it('200 with per-store counters; no record key, title, identity or error text', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-reconcile-route-'));
    new KnowledgeManager(dir).ingest('body', { title: 'Private Research Note', url: 'https://example.com/private-note', type: 'doc' });
    // A corrupt PII file: the user registry is unreadable (and carries a name in its bytes).
    fs.writeFileSync(path.join(dir, 'users.json'), '[{"id":"u1","name":"Jane Q Private","channels":[{"type":"telegram","identifier":"5551234"}');
    const { reconciler, appended } = build();
    await reconciler.tick();
    expect(appended.filter((d) => d.op === 'put')).toHaveLength(1); // the knowledge row

    await start(reconciler);
    const res = await fetch(`${server!.url}/state/reconcile`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(typeof body.intervalMs).toBe('number');
    expect(body.lastTickAt).not.toBeNull();
    expect(Object.keys(body.stores).sort()).toEqual(['evolutionActions', 'knowledge', 'learnings', 'preferences', 'relationships', 'userRegistry']);

    const kb = body.stores.knowledge;
    expect(kb).toMatchObject({ seeded: true, emittedPuts: 1, present: true, putsOnly: false, gitCarried: false, lastError: null });
    const users = body.stores.userRegistry;
    expect(users.snapshotFailed).toBe(1);
    expect(users.lastError).toBe('snapshot-unreadable');
    expect(users.putsOnly).toBe(true);
    // A dark store was never read.
    expect(body.stores.learnings.seeded).toBe(false);

    const raw = JSON.stringify(body);
    const key = deriveKnowledgeRecordKey('Private Research Note', 'https://example.com/private-note', 'doc')!;
    for (const needle of [key, 'Private Research Note', 'private-note', 'Jane Q Private', '5551234', 'JSON', 'Unexpected']) {
      expect(raw).not.toContain(needle);
    }
  });
});
