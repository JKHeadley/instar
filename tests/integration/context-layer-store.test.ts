// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — the context layer store on its real paths
 * (context-budget-layered-summaries §9.7, §14):
 *  - a store write rides the REAL ReplicatedRecordEmitter into the REAL
 *    CoherenceJournal and lands on a second machine through the REAL
 *    JournalSyncApplier; with the store's stateSync flag off nothing is emitted
 *    and the local write still stands;
 *  - GET /context-budget/layers through the real routes: 503 off, 200 on;
 *  - the File Viewer refuses both roots.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { CONTEXT_LAYER_KIND_REGISTRATION, CONTEXT_LAYER_RECORD_KIND, CONTEXT_LAYER_STORE_KEY } from '../../src/monitoring/contextLayerKind.js';
import { buildContextLayers, type LayerEmitter } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { rowRefFor, type LayerMeta } from '../../src/monitoring/contextLayers/LayerStore.js';
import { isNeverServed } from '../../src/server/fileRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/context-layer-store.test.ts';
const META: LayerMeta = { author: { sessionId: 's1', machine: 'm_a', model: 'opus', kind: 'derived' }, asOf: { at: 1, lastMessageId: 9 } };
const dirs: string[] = [];
const journals: CoherenceJournal[] = [];
afterEach(() => {
  for (const j of journals.splice(0)) { try { j.close(); } catch { /* best-effort */ } }
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
});
function tmp(p: string): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; }

function machine(root: string, id: string, reg: ReplicatedKindRegistry, storeOn: boolean) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'state', 'sessions'), { recursive: true });
  const journal = new CoherenceJournal({ stateDir: dir, machineId: id, flushIntervalMs: 1_000_000 });
  journal.open();
  journal.setReplicatedKindRegistry(reg);
  journals.push(journal);
  let t = 1_000;
  const emitter = new ReplicatedRecordEmitter({
    journal, clock: new HybridLogicalClock({ node: id, now: () => (t += 1000) }), registry: reg, origin: id,
    stores: () => ({ [CONTEXT_LAYER_STORE_KEY]: { enabled: storeOn } }), loadWitness: () => undefined,
  });
  const layers = buildContextLayers({ stateDir: dir, authToken: 'auth-token-value-0123456789', emitter: emitter as unknown as LayerEmitter });
  return { id, dir, journal, layers };
}

describe('layer store → journal → second machine', () => {
  it('a derived write and a protected reference replicate; the scrubbed body is what travels', () => {
    const root = tmp('cls-repl-');
    const reg = new ReplicatedKindRegistry();
    reg.register(CONTEXT_LAYER_KIND_REGISTRATION);
    const A = machine(root, 'm_a', reg, true);
    const B = machine(root, 'm_b', reg, true);
    const w1 = A.layers.store.writeDerived('141133', 'h1', 'current', { text: 'next: tests; saw auth-token-value-0123456789 printed' }, { ...META, status: 'fresh' });
    const w2 = A.layers.store.writeProtected('141133', 'anchor', 'anchor', [rowRefFor(5, 'Build phase 1')], META, { kind: 'framing' });
    expect(w1).toMatchObject({ written: true, replication: 'emitted' });
    expect(w2).toMatchObject({ written: true, replication: 'emitted' });
    A.journal.flush();
    const entries = A.journal.readTail(CONTEXT_LAYER_RECORD_KIND, 10_000).entries.sort((x, y) => x.seq - y.seq);
    const applied = new JournalSyncApplier({ stateDir: B.dir, replicatedRegistry: reg }).apply(A.id, [{ kind: CONTEXT_LAYER_RECORD_KIND, incarnation: `${A.id}-1`, entries }]);
    expect(applied).toMatchObject({ applied: 2, invalidEntries: 0, forgedEntries: 0 });
    const byKey = new ReplicatedPeerStreamReader({ stateDir: B.dir, registry: reg, selfMachineId: B.id, autoRebuild: true }).loadAllOriginRecords(CONTEXT_LAYER_STORE_KEY);
    const h1 = byKey.get('141133:h1:current')!.find((r) => r.origin === A.id)!;
    expect(h1.data.status).toBe('fresh');
    const body = JSON.parse(String(h1.data.body)) as { data: { text: string }; author: { machine: string } };
    expect(body.data.text).toBe('next: tests; saw [REDACTED:live-secret] printed');
    expect(body.author.machine).toBe('m_a');
    const anchor = JSON.parse(String(byKey.get('141133:anchor:anchor')!.find((r) => r.origin === A.id)!.data.body)) as { rows: Array<{ messageId: number }> };
    expect(anchor.rows[0].messageId).toBe(5);
    expect(JSON.stringify(anchor)).not.toContain('Build phase 1');
    expect(A.layers.status().replication.emitted).toBe(2);
  });

  it('with the store\'s stateSync flag off, nothing reaches the journal and the local write stands', () => {
    const root = tmp('cls-dark-');
    const reg = new ReplicatedKindRegistry();
    reg.register(CONTEXT_LAYER_KIND_REGISTRATION);
    const A = machine(root, 'm_a', reg, false);
    const w = A.layers.store.writeDerived('141133', 'h1', 'current', { text: 'x' }, META);
    expect(w).toMatchObject({ written: true, replication: 'disabled' });
    A.journal.flush();
    expect(A.journal.readTail(CONTEXT_LAYER_RECORD_KIND, 10).entries).toEqual([]);
    expect(A.layers.store.read('141133', 'h1', 'current')?.data.text).toBe('x');
  });
});

function appFor(stateDir: string, layers: ReturnType<typeof buildContextLayers> | null): express.Express {
  const ctx = {
    config: { projectName: 'echo', projectDir: stateDir, stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    startTime: new Date(),
    contextLayers: layers,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

describe('GET /context-budget/layers', () => {
  it('503 when the layers are off, naming the switch', async () => {
    const sd = tmp('cls-route-off-');
    const r = await request(appFor(sd, null)).get('/context-budget/layers');
    expect(r.status).toBe(503);
    expect(r.body.enableWith).toBe('contextBudget.enabled');
  });

  it('200 with roots, modes, topics and bytes', async () => {
    const sd = tmp('cls-route-on-');
    const layers = buildContextLayers({ stateDir: sd });
    layers.store.writeDerived('141133', 'h1', 'current', { text: 'x' }, META);
    layers.archive.archiveSpan('141133', 's1', [{ entryId: 'e1', fields: { text: 'y' } }]);
    const r = await request(appFor(sd, layers)).get('/context-budget/layers');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, topics: 1, layersRoot: { mode: '0700' }, archiveRoot: { mode: '0700' } });
    expect(r.body.layerBytes).toBeGreaterThan(0);
    expect(r.body.archiveBytes).toBeGreaterThan(0);
  });
});

describe('File Viewer posture', () => {
  it('never serves either root, in either spelling', () => {
    for (const p of ['state/context-layers/141133/h1/current.json', '.instar/state/context-layers/x', 'state/context-archive/141133/index.json', '.instar/state/context-archive/t/spans/s.jsonl.gz']) {
      expect(isNeverServed(p), p).toBe(true);
    }
  });
});
