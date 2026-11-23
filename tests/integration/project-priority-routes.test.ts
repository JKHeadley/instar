import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS } from '../../src/core/ChiefOfStaffLoop.js';
import { mountProjectsRoutes } from '../../src/server/workProjectsRoutes.js';
import { mountProjectPriorityRoutes } from '../../src/server/projectPriorityRoutes.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { CHIEF_OF_STAFF_KIND_REGISTRATION, CHIEF_OF_STAFF_RECORD_KIND, CHIEF_OF_STAFF_STORE_KEY, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const key = 'telegram:144201';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function fixture(failDurability = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-priority-'));
  const registry = new ReplicatedKindRegistry(); registry.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
  const journal = new CoherenceJournal({ stateDir: dir, machineId: 'm1', flushIntervalMs: 1000000 }); journal.open(); journal.setReplicatedKindRegistry(registry);
  cleanup.push(() => { journal.close(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/project-priority-routes.test.ts' }); });
  const emitter = new ReplicatedRecordEmitter({ journal, registry, clock: new HybridLogicalClock({ node: 'm1', now: () => Date.now() }), origin: 'm1', stores: () => ({ [CHIEF_OF_STAFF_STORE_KEY]: { enabled: true } }), loadWitness: () => undefined });
  const read = (): UnionEntry[] => journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 10000).entries.map((e) => ({ data: e.data as Record<string, unknown>, origin: 'm1' }));
  const deps = {
    now: () => Date.now(), machineId: 'm1', enabled: () => true, holdsLease: () => true, config: () => CHIEF_OF_STAFF_LOOP_DEFAULTS,
    journal: { emit: (k: string, b: Parameters<ReplicatedRecordEmitter['emit']>[2]) => emitter.emit(CHIEF_OF_STAFF_STORE_KEY, k, b), loadUnion: read, loadUnionComplete: read, awaitDurable: async (seq: number) => { if (failDurability) throw new Error('durability unavailable'); journal.flush(); await journal.awaitDurableSeq(CHIEF_OF_STAFF_RECORD_KIND, seq, 3000); } },
    verifyRenewal: () => true, gather: async () => { throw new Error('not used'); }, judge: async () => null,
    protocol: {} as never, mirrorInitiativeStatus: () => {}, sendNote: async () => {}, sendImmediate: async () => {}, statusUrl: () => '', localHour: () => 8,
  };
  const loop = new ChiefOfStaffLoop(deps);
  loop.bindProject({ conversationKey: key, goal: 'Token pacing', doneDefinition: [{ id: 'a', kind: 'judgment', text: 'Owner happy' }] }); journal.flush();
  let invalidations = 0;
  const app = express(); app.use(express.json());
  const projects = mountProjectsRoutes(app as never, { projects: () => loop.projectsOverview(), boardFor: () => ({ status: 200, body: { lanes: [] } }), bearerOk: () => true });
  mountProjectPriorityRoutes(app as never, { loop: () => loop, ownerProof: (req) => req.headers['x-instar-operator-session'] === 'owner-proof', invalidate: () => { invalidations++; projects.invalidate(); } });
  return { app, loop, read, restart: () => new ChiefOfStaffLoop(deps), invalidations: () => invalidations };
}
describe('owner project priority HTTP flow with real replicated journal', () => {
  it('refuses a plain bearer or a forged owner in the body', async () => {
    const f = fixture();
    const res = await request(f.app).post(`/work/projects/${encodeURIComponent(key)}/priority`).set('Authorization', 'Bearer agent').send({ priority: 'high', confirmedBy: 'owner' });
    expect(res.status).toBe(403); expect(res.body.error).toBe('owner-proof-required');
    expect(f.read().some((e) => e.data.recordType === 'project-priority')).toBe(false);
  });
  it('persists the owner signal across loop restart without changing the binding', async () => {
    const f = fixture(); const before = f.loop.projectDetail(key);
    expect((await request(f.app).get('/work/projects')).body.projects[0].priority).toBe('normal');
    const res = await request(f.app).post(`/work/projects/${encodeURIComponent(key)}/priority`).set('x-instar-operator-session', 'owner-proof').send({ priority: 'high' });
    expect(res.status).toBe(200); expect(res.body).toMatchObject({ ok: true, priority: 'high' });
    expect(f.loop.projectsOverview()?.[0].priority).toBe('high');
    expect((await request(f.app).get('/work/projects')).body.projects[0].priority).toBe('high');
    expect(f.restart().projectDetail(key)?.priority).toBe('high');
    expect(f.loop.projectDetail(key)?.doneDefinition).toEqual(before?.doneDefinition);
    expect(f.invalidations()).toBe(1);
    const normal = await request(f.app).post(`/work/projects/${encodeURIComponent(key)}/priority`).set('x-instar-operator-session', 'owner-proof').send({ priority: 'normal' });
    expect(normal.status).toBe(200); expect(f.restart().projectDetail(key)?.priority).toBe('normal');
  });
  it('does not acknowledge a save when durable recording fails', async () => {
    const f = fixture(true);
    const res = await request(f.app).post(`/work/projects/${encodeURIComponent(key)}/priority`).set('x-instar-operator-session', 'owner-proof').send({ priority: 'high' });
    expect(res.status).toBe(409); expect(res.body.error).toBe('write-refused');
    expect(f.invalidations()).toBe(0);
  });
  it('refuses invalid values and unknown projects without writing a priority', async () => {
    const f = fixture();
    for (const [target, priority, status] of [[key, 'urgent', 400], ['telegram:999', 'low', 404]] as const) {
      const res = await request(f.app).post(`/work/projects/${encodeURIComponent(target)}/priority`).set('x-instar-operator-session', 'owner-proof').send({ priority });
      expect(res.status).toBe(status);
    }
    expect(f.read().some((e) => e.data.recordType === 'project-priority')).toBe(false);
  });
});
